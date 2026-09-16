'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson } = require('../recorder/atomic-json');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-json-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'state.json');
}

test('atomic JSON roundtrip, replacement and absent fallback', t => {
  const file = fixture(t);
  assert.equal(readJson(file), null);
  writeJson(file, { state: 'queued' });
  assert.deepEqual(readJson(file), { state: 'queued' });
  writeJson(file, { state: 'complete' });
  assert.deepEqual(readJson(file), { state: 'complete' });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('corruption and size limits never become missing-state fallback', t => {
  const file = fixture(t);
  fs.writeFileSync(file, 'broken');
  assert.throws(() => readJson(file, { fallback: {} }), SyntaxError);
  assert.throws(() => readJson(file, { maxBytes: 3 }), /size limit/);
  assert.throws(() => readJson(file, { maxBytes: -1 }), /size limit/);
});

test('write failure leaves existing state and no temp files', t => {
  const file = fixture(t);
  writeJson(file, { safe: true });
  const circular = {}; circular.self = circular;
  assert.throws(() => writeJson(file, circular));
  assert.deepEqual(readJson(file), { safe: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  assert.throws(() => writeJson(path.join(file, 'child'), {}));
});

test('rejects directories and symbolic link reads/writes', t => {
  const file = fixture(t);
  assert.throws(() => readJson(path.dirname(file)), /regular/);
  assert.throws(() => writeJson(path.dirname(file), {}), /regular/);
  const target = `${file}.target`;
  fs.writeFileSync(target, '{}');
  try { fs.symlinkSync(target, file); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Symlink privilege unavailable'); return; } throw error; }
  assert.throws(() => readJson(file), /regular/);
  assert.throws(() => writeJson(file, {}), /regular/);
});
