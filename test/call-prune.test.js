'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneAudio } = require('../recorder/call-prune');
const { processCall } = require('../recorder/call-work');
const { CallState } = require('../recorder/call-state');

const id = '9b918241-3cb0-447c-8861-8f14358563e7';

test('pruneAudio removes segments and derived, keeps manifest and processing state, and is idempotent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'segments', 'track-a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'derived'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'segments', 'track-a', '0000.wav'), 'audio');
  fs.writeFileSync(path.join(dir, 'derived', 'call.wav'), 'audio');
  fs.writeFileSync(path.join(dir, 'derived', 'window-000000.wav'), 'audio');
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(dir, 'processing.json'), '{}');
  assert.deepEqual(await pruneAudio(dir), ['segments', 'derived']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['manifest.json', 'processing.json']);
  assert.deepEqual(await pruneAudio(dir), []);
});

test('a pruned call with a transcript stays complete and never renders or uploads again', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sessionId: id, protocolVersion: 1, state: 'stopped', tracks: [], segments: [] }));
  const store = new CallState(root, path.join(root, 'settings.json'));
  const saved = [];
  const processor = { store, http: { origin: () => { throw new Error('never'); } }, abort: new AbortController(),
    helperPath: '/helper', spawnProcess: () => { throw new Error('render must not run'); },
    save: async state => { saved.push(JSON.parse(JSON.stringify(state))); } };
  const transcript = { text: 'Me: hello\nThem: hi', segments: [{ startMs: 0, endMs: 500, text: 'hello', speaker: 'me' }] };
  const state = { ...(await store.load(id)), state: 'preparing', preparePending: true, requested: true, audioPruned: true, transcript };
  await processCall(processor, state);
  assert.equal(state.state, 'complete');
  assert.equal(state.preparePending, false);
  assert.deepEqual(state.transcript, transcript);
  assert.equal(saved.length, 1);
  const noTranscript = { ...(await store.load(id)), audioPruned: true, transcript: null };
  await assert.rejects(processCall(processor, noTranscript), e => e.code === 'audio-pruned');
});
