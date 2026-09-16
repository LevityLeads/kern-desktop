'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { safePath, callDirectory, hashFile, CallError } = require('../recorder/call-files');
const { stableId, uploadInventory } = require('../recorder/call-derived');
const { originOf, responseJson, statusError } = require('../recorder/call-http');
const { CallState, fresh } = require('../recorder/call-state');
const { CallProcessing } = require('../recorder/call-processing');

const SESSION = '9b918241-3cb0-447c-8861-8f14358563e7';
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kern-jobs-')); }

test('safePath rejects traversal, backslashes and reserved names', async () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, 'segments'), { recursive: true });
    fs.writeFileSync(path.join(root, 'segments', 'a.wav'), 'x');
    // Normalise both sides: Windows realpath may return 8.3 short or long forms.
    const resolved = await safePath(root, 'segments/a.wav');
    assert.equal(fs.realpathSync(resolved), fs.realpathSync(path.join(root, 'segments', 'a.wav')));
    for (const bad of ['../escape', 'segments\\a.wav', 'segments/../../x', 'seg:ments', 'con.wav']) {
      await assert.rejects(safePath(root, bad), e => e instanceof CallError);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('callDirectory rejects a regular file masquerading as a session', async () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, SESSION), 'not a dir');
    await assert.rejects(callDirectory(root, SESSION), e => e instanceof CallError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hashFile enforces declared byte length and checksum', async () => {
  const root = tmp();
  try {
    const body = Buffer.from('audio-bytes');
    fs.writeFileSync(path.join(root, 'call.wav'), body);
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const ok = await hashFile(root, 'call.wav', { byteLength: body.length, sha256: sha });
    assert.equal(ok.sha256, sha);
    await assert.rejects(hashFile(root, 'call.wav', { byteLength: body.length, sha256: 'f'.repeat(64) }));
    await assert.rejects(hashFile(root, 'call.wav', { byteLength: 999, sha256: sha }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stableId is deterministic and a valid v4-shaped uuid', () => {
  const a = stableId(SESSION, 'f'.repeat(64), 'segments/x.wav');
  const b = stableId(SESSION, 'f'.repeat(64), 'segments/x.wav');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, stableId(SESSION, 'f'.repeat(64), 'segments/y.wav'));
});

test('uploadInventory rejects calls longer than two hours', async () => {
  const dir = tmp();
  try {
    const validated = { manifest: { segments: [], tracks: [] }, fingerprint: 'f'.repeat(64),
      derived: { sampleCount: (7200000 + 1000) * 16, windows: [] } };
    await assert.rejects(uploadInventory(dir, SESSION, validated), e => e.code === 'too-long');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('originOf demands https without credentials', () => {
  assert.equal(originOf('https://kern.example.org/app'), 'https://kern.example.org');
  for (const bad of ['http://kern.example.org', 'https://u:p@kern.example.org', 'not a url']) {
    assert.throws(() => originOf(bad), e => e instanceof CallError);
  }
});

test('statusError classifies auth, retryable and conflict codes', () => {
  assert.equal(statusError(401).code, 'auth');
  assert.equal(statusError(503).retry, true);
  assert.equal(statusError(409).code, 'conflict');
  assert.equal(statusError(401, true).code, 'upload-expired');
});

test('responseJson treats a truncated read as retryable network, not malformed', async () => {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"a":')); controller.error(new Error('reset')); },
  });
  const response = new Response(body, { headers: { 'content-type': 'application/json' } });
  await assert.rejects(responseJson(response), e => e.code === 'network' && e.retry === true);
});

test('call state persists cloud preference and never treats corrupt state as consent', async () => {
  const root = tmp();
  const settings = path.join(root, 'call-settings.json');
  try {
    const store = new CallState(root, settings);
    assert.deepEqual(await store.preference(), { enabled: false });
    await store.setPreference(true);
    assert.deepEqual(await store.preference(), { enabled: true });
    const dir = path.join(root, SESSION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'processing.json'), '{ corrupt');
    assert.deepEqual(await store.pending(), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('getCall on an untouched recording reports local with no leaked url', async () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, SESSION), { recursive: true });
    const processing = new CallProcessing({ recordingsRoot: root, helperPath: '/helper',
      getSession: () => null, getOrigin: () => 'https://kern.example.org', settingsPath: path.join(root, 'call-settings.json') });
    const call = await processing.getCall(SESSION);
    assert.equal(call.state, 'local');
    assert.equal(call.playbackUrl, null);
    assert.equal(call.transcript, null);
    await processing.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fresh state carries owner and storage binding slots', () => {
  const state = fresh(SESSION);
  assert.equal(state.ownerId, null);
  assert.equal(state.storageOrigin, null);
  assert.equal(state.consent, false);
});
