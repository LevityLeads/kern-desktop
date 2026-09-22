'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { CallProcessing } = require('../recorder/call-processing');
const { startLivePublisher, availableMs } = require('../recorder/call-live');
const { stableId, validateLiveManifest } = require('../recorder/call-derived');
const { fresh } = require('../recorder/call-state');

const SESSION = '5c1e9d3a-7b2f-4e6a-9c0d-1f2a3b4c5d6e';
const REMOTE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const ORIGIN = 'https://kern.example.org';
const STORAGE = 'https://store.example.org';
const RATE = 16000, CORE = 60 * RATE, OVERLAP = RATE, TICKS = 10_000_000, ORIGIN_TICKS = 1234567;

function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
// The processor resolves call directories through fs.promises.realpath (libuv-native), which expands
// Windows 8.3 short names (RUNNER~1 on the CI runner). The JS realpathSync does not, so only the
// native variant produces the same string the processor hands to the helper.
function tmp() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kern-live-'))); }
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
// Exactly the bytes and metadata the native renderer publishes for window k, live or final.
function windowFile(k, sampleCount = Infinity) {
  const coreStart = k * CORE, coreEnd = Math.min(sampleCount, coreStart + CORE);
  const start = Math.max(0, coreStart - OVERLAP), end = Math.min(sampleCount, coreEnd + OVERLAP);
  const bytes = Buffer.alloc(44 + (end - start) * 2, k + 1);
  const name = `window-${String(k).padStart(6, '0')}`;
  return { bytes, meta: { windowId: name, relativePath: `derived/${name}.wav`, byteLength: bytes.length, sha256: sha(bytes),
    startSample: start, endSample: end, coreStartSample: coreStart, coreEndSample: coreEnd,
    startSeconds: start / RATE, endSeconds: end / RATE, coreStartSeconds: coreStart / RATE, coreEndSeconds: coreEnd / RATE } };
}
function windowId(k, sampleCount) { const { meta } = windowFile(k, sampleCount); return stableId(SESSION, meta.sha256, meta.relativePath); }
// Capture manifest with 5 s finalised checkpoints per track, ending at the given millisecond per track.
function captureManifest(dir, tracks, state = 'recording', withFiles = false) {
  const manifest = { sessionId: SESSION, protocolVersion: 1, state, timelineFrequency: TICKS, timelineOriginTicks: ORIGIN_TICKS,
    tracks: Object.keys(tracks).map(trackId => ({ trackId, kind: trackId, health: 'ok',
      format: { encoding: 'pcm', sampleRate: 48000, channels: 1, bitsPerSample: 16 } })), segments: [] };
  for (const [trackId, endMs] of Object.entries(tracks)) {
    for (let s = 0; s * 5000 < endMs; s += 1) {
      const relativePath = `segments/${trackId}/${String(s).padStart(4, '0')}.wav`;
      const bytes = Buffer.alloc(1044, s + 1);
      if (withFiles) {
        fs.mkdirSync(path.join(dir, 'segments', trackId), { recursive: true });
        fs.writeFileSync(path.join(dir, relativePath), bytes);
      }
      manifest.segments.push({ trackId, status: 'finalised', relativePath, sampleCount: 500, byteLength: bytes.length, sha256: sha(bytes),
        timelineStartTicks: ORIGIN_TICKS + s * 5 * TICKS, timelineEndTicks: ORIGIN_TICKS + Math.min(endMs, (s + 1) * 5000) * (TICKS / 1000) });
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
// A fake helper: renders every window whose trailing overlap fits inside --through.
function liveRenderer(dir, { calls = [], onSpawn = null, deferKill = false } = {}) {
  return (file, args) => {
    calls.push(args);
    const child = new EventEmitter(); child.stderr = new EventEmitter();
    const through = Number(args[args.indexOf('--through') + 1]);
    const count = Math.max(0, Math.floor((through * 16 - OVERLAP) / CORE));
    fs.mkdirSync(path.join(dir, 'derived'), { recursive: true });
    const windows = [];
    for (let k = 0; k < count; k += 1) {
      const { bytes, meta } = windowFile(k);
      fs.writeFileSync(path.join(dir, meta.relativePath), bytes);
      windows.push(meta);
    }
    fs.writeFileSync(path.join(dir, 'derived', 'live-manifest.json'), JSON.stringify({ version: 1, rendererVersion: 'kern-call-render-1',
      sessionId: SESSION, sourceFingerprint: 'f'.repeat(64), throughSamples: through * 16, sampleRate: RATE, channels: 1, bitsPerSample: 16,
      peakPolicy: 'none', complete: false, windows }));
    if (deferKill) child.kill = () => { onSpawn?.('kill'); setImmediate(() => { onSpawn?.('close'); child.emit('close', null); }); return true; };
    else { child.kill = () => true; setImmediate(() => child.emit('close', 0)); }
    onSpawn?.('spawn');
    return child;
  };
}
// Records every API request and signed PUT; routes are the live and post-call contract.
function fakeCloud(t, { windowsStatus = 200, callState = 'live', status = {} } = {}) {
  const requests = [], puts = [];
  const session = { fetch: async (url, init) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method, route, body, owner: init.headers['x-kern-owner-id'] || null });
    if (route === '/api/calls/identity') return json({ ownerId: 'owner-1', storageOrigin: STORAGE });
    if (route === '/api/calls/live') return json({ id: REMOTE, sessionId: body.sessionId, state: 'live', ownerId: 'owner-1' });
    if (route === `/api/calls/${REMOTE}/windows`) {
      if (windowsStatus !== 200) return new Response('', { status: windowsStatus });
      return json({ id: REMOTE, objectId: body.object.id, windowIndex: body.object.windowIndex, windowCount: body.object.windowIndex + 1 });
    }
    if (route === `/api/calls/${REMOTE}/upload`) return json({ signedUrl: `${STORAGE}/storage/v1/object/upload/sign/calls/${body.objectId}?token=t` });
    if (route === `/api/calls/${REMOTE}/live-finalize`) return json({ id: REMOTE, state: 'validating' });
    if (route === `/api/calls/${REMOTE}`) return json({ id: REMOTE, state: callState, ...status });
    return new Response('', { status: 404 });
  } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method !== 'PUT') throw new Error('unexpected fetch');
    puts.push(new URL(url).pathname.split('/').pop());
    return new Response(null, { status: 200 });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return { session, requests, puts };
}
function processorFor(t, root, session, spawnProcess) {
  const processor = new CallProcessing({ recordingsRoot: root, helperPath: '/helper', getSession: () => session, getOrigin: () => ORIGIN,
    settingsPath: path.join(root, 'call-settings.json'), spawnProcess });
  t.after(() => processor.stop());
  return processor;
}
function recordingState(extra = {}) {
  return { ...fresh(SESSION), state: 'recording', consent: true, origin: ORIGIN, ...extra };
}
function setup(t, tracks, cloudOptions, rendererOptions) {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, SESSION); fs.mkdirSync(dir);
  captureManifest(dir, tracks);
  const cloud = fakeCloud(t, cloudOptions);
  const calls = [];
  const processor = processorFor(t, root, cloud.session, liveRenderer(dir, { calls, ...rendererOptions }));
  return { root, dir, cloud, calls, processor };
}

test('availableMs floors exact ticks and ignores a track that stopped publishing', () => {
  const dir = tmp();
  try {
    assert.equal(availableMs(captureManifest(dir, { mic: 135000, sys: 135000 })), 135000);
    assert.equal(availableMs(captureManifest(dir, { mic: 135000, sys: 115000 })), 135000);
    assert.equal(availableMs(captureManifest(dir, { mic: 135000, sys: 125000 })), 125000);
    assert.equal(availableMs(captureManifest(dir, {})), null);
    assert.equal(availableMs({ timelineFrequency: 3, timelineOriginTicks: 0, segments: [{ trackId: 'a', status: 'finalised', timelineEndTicks: 2 }] }), 666);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('live publisher opens once, registers and uploads complete windows in order, then idles', async t => {
  const { dir, cloud, calls, processor } = setup(t, { mic: 135000, sys: 135000 });
  await processor.store.save(recordingState());
  const publisher = startLivePublisher(processor, SESSION, { intervalMs: 3600000 });
  t.after(() => publisher.stop());
  await publisher.tick();
  const state = await processor.store.load(SESSION);
  assert.equal(state.state, 'recording');
  assert.equal(state.live, true);
  assert.equal(state.remoteId, REMOTE);
  assert.equal(state.ownerId, 'owner-1');
  assert.equal(state.liveWindows, 2);
  assert.equal(state.liveError, null);
  assert.deepEqual(state.uploaded, [windowId(0), windowId(1)]);
  assert.equal(state.fingerprint, null);
  assert.deepEqual(calls, [['--render', dir, '--through', '133000']]);
  const opens = cloud.requests.filter(r => r.route === '/api/calls/live');
  assert.equal(opens.length, 1);
  assert.deepEqual(opens[0].body, { version: 1, sessionId: SESSION });
  const windows = cloud.requests.filter(r => r.route.endsWith('/windows'));
  assert.equal(windows.length, 2);
  assert.ok(windows.every(r => r.owner === 'owner-1'));
  const [first, second] = windows.map(r => r.body.object);
  assert.equal(first.id, windowId(0)); assert.equal(second.id, windowId(1));
  assert.deepEqual([first.windowIndex, first.startMs, first.endMs, first.coreStartMs, first.coreEndMs], [0, 0, 61000, 0, 60000]);
  assert.deepEqual([second.windowIndex, second.startMs, second.endMs, second.coreStartMs, second.coreEndMs], [1, 59000, 121000, 60000, 120000]);
  assert.equal(first.kind, 'window');
  assert.deepEqual(first.wav, { sampleRate: 16000, channels: 1, bitsPerSample: 16, format: 'pcm', frames: 61000 * 16 });
  assert.equal(first.sha256, windowFile(0).meta.sha256);
  assert.deepEqual(cloud.puts, [windowId(0), windowId(1)]);
  assert.ok(validateLiveManifest(dir, SESSION));
  // No new audio: nothing is rendered or posted again.
  const before = cloud.requests.length;
  await publisher.tick();
  assert.equal(calls.length, 1);
  assert.equal(cloud.requests.length, before);
  assert.equal((await processor.store.load(SESSION)).liveWindows, 2);
});

test('live publisher stops after five consecutive failures without touching the capture state', async t => {
  const { cloud, calls, processor } = setup(t, { mic: 135000, sys: 135000 }, { windowsStatus: 500 });
  await processor.store.save(recordingState());
  const publisher = startLivePublisher(processor, SESSION, { intervalMs: 3600000 });
  for (let i = 0; i < 4; i += 1) {
    await publisher.tick();
    assert.equal((await processor.store.load(SESSION)).liveError, null);
  }
  await publisher.tick();
  const state = await processor.store.load(SESSION);
  assert.equal(state.liveError, 'network');
  assert.equal(state.state, 'recording');
  assert.equal(state.live, true);
  assert.equal(state.liveWindows, 0);
  assert.deepEqual(state.uploaded, []);
  assert.equal(calls.length, 5);
  assert.equal(cloud.requests.filter(r => r.route === '/api/calls/live').length, 1);
  await publisher.tick();
  assert.equal(calls.length, 5);
  await publisher.stop();
});

test('live publisher stops on auth failure at the first attempt', async t => {
  const { processor } = setup(t, { mic: 135000, sys: 135000 });
  await processor.store.save(recordingState());
  const publisher = startLivePublisher(processor, SESSION, { intervalMs: 3600000 });
  t.after(() => publisher.stop());
  processor.http.getSession = () => null;
  await publisher.tick();
  const state = await processor.store.load(SESSION);
  assert.equal(state.liveError, 'auth');
  assert.equal(state.state, 'recording');
});

test('a track that stopped publishing does not hold available audio back', async t => {
  const { dir, cloud, calls, processor } = setup(t, { mic: 135000, sys: 115000 });
  await processor.store.save(recordingState());
  const publisher = startLivePublisher(processor, SESSION, { intervalMs: 3600000 });
  t.after(() => publisher.stop());
  await publisher.tick();
  assert.deepEqual(calls, [['--render', dir, '--through', '133000']]);
  assert.equal((await processor.store.load(SESSION)).liveWindows, 2);
  assert.equal(cloud.requests.filter(r => r.route.endsWith('/windows')).length, 2);
});

test('live publisher does nothing without consent or once capture is no longer active', async t => {
  const { dir, cloud, calls, processor } = setup(t, { mic: 135000, sys: 135000 });
  await processor.store.save(recordingState({ consent: false }));
  const publisher = startLivePublisher(processor, SESSION, { intervalMs: 3600000 });
  t.after(() => publisher.stop());
  await publisher.tick();
  await processor.store.save(recordingState());
  captureManifest(dir, { mic: 135000, sys: 135000 }, 'stopped');
  const again = startLivePublisher(processor, SESSION, { intervalMs: 3600000 });
  t.after(() => again.stop());
  await again.tick();
  assert.equal(calls.length, 0);
  assert.equal(cloud.requests.length, 0);
});

test('validateLiveManifest rejects a completed, foreign or misshapen live manifest', async t => {
  const { dir, processor } = setup(t, { mic: 135000, sys: 135000 });
  await processor.store.save(recordingState());
  const publisher = startLivePublisher(processor, SESSION, { intervalMs: 3600000 });
  t.after(() => publisher.stop());
  await publisher.tick();
  const file = path.join(dir, 'derived', 'live-manifest.json');
  const good = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const mutate of [m => { m.complete = true; }, m => { m.sessionId = REMOTE; }, m => { m.windows[1].coreEndSample -= 16; },
    m => { m.windows[0].relativePath = 'derived/window-000001.wav'; }, m => { m.windows[0].byteLength += 2; }, m => { m.throughSamples = CORE; }]) {
    const bad = JSON.parse(JSON.stringify(good)); mutate(bad);
    fs.writeFileSync(file, JSON.stringify(bad));
    await assert.rejects(validateLiveManifest(dir, SESSION), e => e.code === 'invalid-recording');
  }
});

test('processCall after a live call uploads only new objects and seals through live-finalize', async t => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, SESSION); fs.mkdirSync(path.join(dir, 'derived'), { recursive: true });
  captureManifest(dir, { mic: 135000, sys: 135000 }, 'stopped', true);
  const fingerprint = sha(fs.readFileSync(path.join(dir, 'manifest.json')));
  const sampleCount = 135 * RATE;
  const audio = Buffer.alloc(44 + sampleCount * 2);
  fs.writeFileSync(path.join(dir, 'derived', 'call.wav'), audio);
  const windows = [];
  for (let k = 0; k < 3; k += 1) {
    const { bytes, meta } = windowFile(k, sampleCount);
    fs.writeFileSync(path.join(dir, meta.relativePath), bytes);
    windows.push(meta);
  }
  fs.writeFileSync(path.join(dir, 'derived', 'manifest.json'), JSON.stringify({ version: 1, rendererVersion: 'kern-call-render-1', complete: true,
    sessionId: SESSION, sourceFingerprint: fingerprint, sampleRate: RATE, channels: 1, bitsPerSample: 16, sampleCount,
    durationSeconds: sampleCount / RATE, sourceIntegrity: 'verified',
    audio: { relativePath: 'derived/call.wav', byteLength: audio.length, sha256: sha(audio) }, windows, warnings: [] }));
  const cloud = fakeCloud(t, { callState: 'live' });
  const processor = processorFor(t, root, cloud.session, () => { throw new Error('final render must not run: derived output is complete'); });
  await processor.store.save({ ...fresh(SESSION), state: 'preparing', preparePending: true, consent: true, requested: true, origin: ORIGIN,
    ownerId: 'owner-1', storageOrigin: STORAGE, remoteId: REMOTE, live: true, liveWindows: 2, uploaded: [windowId(0), windowId(1)] });
  processor.schedule(SESSION);
  await processor.running;
  const state = await processor.store.load(SESSION);
  assert.equal(state.error, null);
  assert.equal(state.state, 'transcribing');
  assert.equal(state.uploadFinalized, true);
  assert.equal(state.fingerprint, fingerprint);
  assert.equal(state.durationMs, 135000);
  const originals = [];
  for (const track of ['mic', 'sys']) for (let s = 0; s < 27; s += 1) originals.push(stableId(SESSION, fingerprint, `segments/${track}/${String(s).padStart(4, '0')}.wav`));
  assert.deepEqual(cloud.puts, [...originals, windowId(2, sampleCount)]);
  assert.ok(!cloud.puts.includes(windowId(0)) && !cloud.puts.includes(windowId(1)));
  assert.equal(cloud.requests.filter(r => r.route === `/api/calls/${REMOTE}/finalize`).length, 0);
  assert.equal(cloud.requests.filter(r => r.route === '/api/calls' && r.method === 'POST').length, 0);
  const sealed = cloud.requests.filter(r => r.route === `/api/calls/${REMOTE}/live-finalize`);
  assert.equal(sealed.length, 1);
  assert.equal(sealed[0].body.sessionId, SESSION);
  assert.equal(sealed[0].body.durationMs, 135000);
  assert.deepEqual(sealed[0].body.objects.map(o => o.id), [...originals, windowId(0), windowId(1), windowId(2, sampleCount)]);
  assert.deepEqual(state.uploaded, [windowId(0), windowId(1), ...originals, windowId(2, sampleCount)]);
});

test('polling a transcribing call surfaces the worker error, attempt count and window progress instead of a silent wait', async t => {
  // Rees's 2026-09-22 call sat on "transcribing" for 40 minutes while the worker failed the
  // same window seven times. The status carried the reason the whole time; it was never shown.
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, SESSION), { recursive: true });
  const cloud = fakeCloud(t, { callState: 'transcribing',
    status: { windowCount: 6, errorCode: 'provider_invalid', job: { stage: 'transcribe', cursor: 2, attempts: 7, errorCode: 'provider_invalid', nextAttemptAt: null } } });
  const processor = processorFor(t, root, cloud.session, () => { throw new Error('no render during a cloud poll'); });
  await processor.store.save({ ...fresh(SESSION), state: 'transcribing', consent: true, requested: true, origin: ORIGIN,
    ownerId: 'owner-1', storageOrigin: STORAGE, remoteId: REMOTE, uploadFinalized: true, durationMs: 337290, fingerprint: 'f'.repeat(64) });
  processor.schedule(SESSION);
  await processor.running;
  const state = await processor.store.load(SESSION);
  assert.equal(state.state, 'transcribing');
  assert.equal(state.processingStage, 'cloud-transcribing');
  assert.equal(state.errorCode, 'provider_invalid');
  assert.equal(state.error, "Kern's transcription worker hit provider_invalid (attempt 7 of 8, window 3 of 6) and is retrying.");
  assert.equal(state.progress, 2 / 6);
  const shown = await processor.getCall(SESSION);
  assert.equal(shown.errorCode, 'provider_invalid');
  assert.equal(shown.processingStage, 'cloud-transcribing');
  // A clean poll clears the message rather than leaving a stale error on screen.
  const clean = fakeCloud(t, { callState: 'transcribing', status: { windowCount: 6, job: { stage: 'transcribe', cursor: 5, attempts: 1, errorCode: null } } });
  const quiet = processorFor(t, root, clean.session, () => { throw new Error('no render during a cloud poll'); });
  quiet.schedule(SESSION);
  await quiet.running;
  const after = await quiet.store.load(SESSION);
  assert.equal(after.error, null);
  assert.equal(after.errorCode, null);
  assert.equal(after.progress, 5 / 6);
});

test('onStarted launches a publisher and onStopped waits for its in-flight tick before scheduling', async t => {
  const events = [];
  let onSpawned = () => {};
  const spawned = new Promise(resolve => { onSpawned = resolve; });
  const { processor } = setup(t, { mic: 135000, sys: 135000 }, {}, { deferKill: true,
    onSpawn: e => { events.push(e); if (e === 'spawn') onSpawned(); } });
  await processor.onStarted(SESSION, { enabled: true, liveCalls: true });
  assert.ok(processor.live.has(SESSION));
  const tick = processor.live.get(SESSION).tick();
  await spawned;
  processor.schedule = () => events.push('schedule');
  await processor.onStopped(SESSION);
  await tick;
  assert.deepEqual(events, ['spawn', 'kill', 'close', 'schedule']);
  assert.equal(processor.live.has(SESSION), false);
  const state = await processor.store.load(SESSION);
  assert.equal(state.state, 'preparing');
  assert.equal(state.live, true);
  assert.equal(state.liveWindows, 0);
  assert.equal(state.liveError, null);
});

test('onStarted never launches a publisher without the liveCalls opt-in, even with consent', async t => {
  const { processor } = setup(t, { mic: 135000, sys: 135000 });
  await processor.onStarted(SESSION, { enabled: true });
  assert.equal(processor.live.has(SESSION), false);
  const state = await processor.store.load(SESSION);
  assert.equal(state.state, 'recording');
  assert.equal(state.consent, true);
  assert.equal(state.live, false);
});

test('call state validates live fields and defaults them for older files', async t => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, SESSION); fs.mkdirSync(dir);
  const { CallState } = require('../recorder/call-state');
  const store = new CallState(root, path.join(root, 'settings.json'));
  const legacy = { ...fresh(SESSION) };
  delete legacy.live; delete legacy.liveWindows; delete legacy.liveError;
  fs.writeFileSync(path.join(dir, 'processing.json'), JSON.stringify(legacy));
  assert.deepEqual((({ live, liveWindows, liveError }) => ({ live, liveWindows, liveError }))(await store.load(SESSION)), { live: false, liveWindows: 0, liveError: null });
  for (const bad of [{ liveWindows: 121 }, { liveWindows: -1 }, { live: 'yes' }, { liveError: 'x'.repeat(201) }]) {
    fs.writeFileSync(path.join(dir, 'processing.json'), JSON.stringify({ ...fresh(SESSION), ...bad }));
    await assert.rejects(store.load(SESSION), e => e.code === 'invalid-state');
  }
});
