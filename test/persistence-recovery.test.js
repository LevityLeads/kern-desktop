'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJson, writeJsonWithRetry, readJson } = require('../recorder/atomic-json');
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
