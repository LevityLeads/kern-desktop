'use strict';

// Shared fixtures for the recorder tests: a synthetic audio.pcm/session.json and a fake Kern API.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SESSION = '5c1e9d3a-7b2f-4e6a-9c0d-1f2a3b4c5d6e';
const REMOTE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
// Any other session is opened as this remote id; the fake serves it only through `fail`.
const OTHER_REMOTE = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const ORIGIN = 'https://kern.example.org';
const STORAGE = 'https://store.example.org';

function tempRoot(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kern-rec-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Frame i: lane 0 (me) = i mod 32768, lane 1 (them) = (3i + 7) mod 32768. Any byte range is checkable.
function pcmFrames(start, count) {
  const buffer = Buffer.alloc(count * 4);
  for (let k = 0; k < count; k += 1) {
    const i = start + k;
    buffer.writeInt16LE(i % 32768, k * 4);
    buffer.writeInt16LE((3 * i + 7) % 32768, k * 4 + 2);
  }
  return buffer;
}

function writeSession(root, { id = SESSION, state = 'stopped', frames = 0, extraBytes = 0 } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio.pcm'), Buffer.concat([pcmFrames(0, frames), Buffer.alloc(extraBytes)]));
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    format: 'kern-call-audio/1', sessionId: id, state, startedAtUtc: '2026-09-22T10:00:00.000Z',
    endedAtUtc: state === 'stopped' ? '2026-09-22T10:02:00.000Z' : null, sampleRate: 16000, channels: 2,
    lanes: ['me', 'them'], committedFrames: frames, producer: { app: 'test', helper: '2.0.0.0', protocol: 2 },
    playbackMode: 'devices', sources: [], pauses: [], failure: null,
  }));
  return dir;
}

function appendFrames(root, from, count, id = SESSION) {
  fs.appendFileSync(path.join(root, id, 'audio.pcm'), pcmFrames(from, count));
}

function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// An in-memory Kern implementing the v2 call contract closely enough to catch ordering mistakes:
// a window must be registered before its upload permission, finalize needs every window uploaded.
function fakeKern({ remoteState = 'live' } = {}) {
  const kern = {
    calls: [], windows: new Map(), uploaded: new Set(), puts: [], state: remoteState, finalized: null,
    transcribedWindows: 0, transcripts: [], fail: null, deleted: false, retried: 0, kernThreadUrl: null,
  };
  kern.session = {
    async fetch(url, init = {}) {
      const { pathname, searchParams } = new URL(url);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      kern.calls.push(`${method} ${pathname}`);
      const failure = kern.fail?.(method, pathname, body, init);
      if (failure) return failure;
      if (pathname === '/api/calls/identity') return json({ ownerId: 'owner-1', storageOrigin: STORAGE });
      if (pathname === '/api/calls/live' && method === 'POST') return json({ id: body.sessionId === SESSION ? REMOTE : OTHER_REMOTE, state: 'live', sessionId: body.sessionId });
      const prefix = `/api/calls/${REMOTE}`;
      if (pathname === `${prefix}/windows`) {
        const existing = kern.windows.get(body.object.windowIndex);
        if (existing && existing.id !== body.object.id) return json({ error: 'overlap' }, 409);
        kern.windows.set(body.object.windowIndex, body.object);
        return json({ id: REMOTE, objectId: body.object.id, windowIndex: body.object.windowIndex, windowCount: kern.windows.size });
      }
      if (pathname === `${prefix}/upload`) {
        if (![...kern.windows.values()].some(w => w.id === body.objectId)) return json({ error: 'unregistered' }, 409);
        return json({ signedUrl: `${STORAGE}/storage/v1/object/upload/sign/calls/${body.objectId}.wav?token=t-${body.objectId}` });
      }
      if (pathname === `${prefix}/live-finalize`) {
        if (body.objects.some(o => !kern.uploaded.has(o.id))) return json({ error: 'missing' }, 409);
        kern.finalized = body;
        kern.state = 'transcribing';
        return json({ id: REMOTE, state: 'validating' }, 202);
      }
      if (pathname === `${prefix}/retry` && method === 'POST') { kern.retried += 1; kern.state = 'transcribing'; return json({ id: REMOTE, state: 'queued' }, 202); }
      if (pathname === `${prefix}/transcript`) {
        const after = Number(searchParams.get('after'));
        const windows = kern.transcripts.filter(w => w.window_index > after).slice(0, Number(searchParams.get('limit')));
        return json({ windows });
      }
      if (pathname === prefix && method === 'DELETE') { kern.deleted = true; return json({ ok: true }); }
      if (pathname === prefix) {
        return json({ id: REMOTE, state: kern.state, windowCount: kern.finalized?.objects.length ?? kern.windows.size,
          transcribedWindows: kern.transcribedWindows, kernThreadUrl: kern.kernThreadUrl });
      }
      return json({ error: 'not found' }, 404);
    },
  };
  kern.upload = async (url, init) => {
    const objectId = /calls\/([0-9a-f-]+)\.wav/.exec(new URL(url).pathname)[1];
    kern.puts.push({ objectId, bytes: Buffer.from(init.body) });
    const failure = kern.failUpload?.(objectId);
    if (failure) return failure;
    if (kern.uploaded.has(objectId)) return json({ statusCode: '409', error: 'Duplicate' }, 400);
    kern.uploaded.add(objectId);
    return new Response(null, { status: 200 });
  };
  return kern;
}

module.exports = { ORIGIN, OTHER_REMOTE, REMOTE, SESSION, STORAGE, appendFrames, fakeKern, json, pcmFrames, sha, tempRoot, writeSession };
