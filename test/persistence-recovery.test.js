'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJson, writeJsonWithRetry, readJson } = require('../recorder/atomic-json');
const { CallProcessing } = require('../recorder/call-processing');
const { CallState, fresh } = require('../recorder/call-state');
const id = '9b918241-3cb0-447c-8861-8f14358563e7';
const denied = (code = 'EPERM', syscall = 'rename') => Object.assign(new Error('private path omitted'), { code, syscall });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-persistence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'state.json') };
}

test('transient replacement refusal retries without deleting previous state or blocking timers', async t => {
  const { file } = fixture(t);
  writeJson(file, { old: true });
  const rename = fs.renameSync;
  let attempts = 0, timerRan = false;
  t.mock.method(fs, 'renameSync', (...args) => {
    attempts++;
    if (attempts < 3) { assert.deepEqual(readJson(file), { old: true }); throw denied(); }
    return rename(...args);
  });
  setTimeout(() => { timerRan = true; }, 0);
  await writeJsonWithRetry(file, { next: true }, { delays: [5, 5] });
  assert.equal(attempts, 3);
  assert.equal(timerRan, true);
  assert.deepEqual(readJson(file), { next: true });
});

test('permanent replacement failure is bounded and preserves destination', async t => {
  const { root, file } = fixture(t);
  writeJson(file, { safe: true });
  let attempts = 0;
  t.mock.method(fs, 'renameSync', () => { attempts++; throw denied(); });
  await assert.rejects(writeJsonWithRetry(file, {}, { delays: [0, 0], wait: async () => {} }), e => e.code === 'EPERM');
  assert.equal(attempts, 3);
  assert.deepEqual(readJson(file), { safe: true });
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});

test('non-rename error does not retry; cleanup cannot mask the original refusal', async t => {
  const { file } = fixture(t);
  let attempts = 0;
  const original = denied('ENOSPC', 'write');
  t.mock.method(fs, 'writeFileSync', () => { attempts++; throw original; });
  t.mock.method(fs, 'unlinkSync', () => { throw denied('EIO', 'unlink'); });
  await assert.rejects(writeJsonWithRetry(file, {}), e => e === original);
  assert.equal(attempts, 1);
});

test('retry revalidates destination before replacing it', async t => {
  const { file } = fixture(t);
  writeJson(file, { old: true });
  t.mock.method(fs, 'renameSync', () => { throw denied(); });
  await assert.rejects(writeJsonWithRetry(file, {}, { delays: [0], wait: async () => {
    fs.unlinkSync(file); fs.mkdirSync(file);
  } }), /regular/);
  assert.equal(fs.statSync(file).isDirectory(), true);
});

test('a delayed preference write cannot overwrite a subsequent opt-out', async t => {
  const { root, file } = fixture(t);
  const store = new CallState(root, file);
  const rename = fs.renameSync;
  let refused = false;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (!refused) { refused = true; throw denied(); }
    return rename(...args);
  });
  const enable = store.setPreference(true);
  const disable = store.setPreference(false);
  await Promise.all([enable, disable]);
  assert.deepEqual(await store.preference(), { enabled: false });
});

function processor() {
  return new CallProcessing({ recordingsRoot: '/unused', helperPath: '/unused',
    settingsPath: '/unused', getOrigin: () => 'https://kern.example.org', getSession: () => null });
}

test('failed state save is visible without durable error state and never uploads', async () => {
  const p = processor();
  const state = { ...fresh(id), state: 'preparing', preparePending: true };
  p.store.load = async () => structuredClone(state);
  p.store.directory = async () => '/unused';
  let saves = 0, network = 0;
  p.store.save = async () => { saves++; throw denied(); };
  p.http.api = async () => { network++; throw new Error('must not upload'); };
  p.queue.add(id);
  await p.drain();
  const result = await p.getCall(id);
  assert.equal(result.state, 'failed');
  assert.equal(result.processingStage, 'save-processing-state');
  assert.equal(result.errorCode, 'EPERM');
  assert.equal(result.errorOperation, 'rename');
  assert.doesNotMatch(result.error, /Original audio is safe|private path/);
  assert.equal(saves, 2);
  assert.equal(network, 0);
  p.store.save = async () => {};
  await p.save(state);
  assert.equal(p.failures.size, 0);
  await p.stop();
});

test('original lookup error survives a second failure saving error state', async () => {
  const p = processor();
  p.store.load = async () => fresh(id);
  p.store.directory = async () => { throw denied('EACCES', 'lstat'); };
  p.store.save = async () => { throw denied(); };
  p.queue.add(id); await p.drain();
  const result = await p.getCall(id);
  assert.equal(result.processingStage, 'locate-recording');
  assert.equal(result.errorOperation, 'lstat');
  assert.equal(result.errorCode, 'EACCES');
  await p.stop();
});

test('unreadable processing state emits a visible failure without granting consent', async () => {
  const p = processor();
  p.store.load = async () => { throw denied('EACCES', 'open'); };
  p.queue.add(id); await p.drain();
  const result = await p.getCall(id);
  assert.equal(result.state, 'failed');
  assert.equal(result.processingStage, 'load-processing-state');
  assert.equal(result.playbackUrl, null);
  await p.stop();
});
