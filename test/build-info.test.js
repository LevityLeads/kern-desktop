'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { readBuildInfo } = require('../recorder/build-info');
const { RecorderSupervisor } = require('../recorder/supervisor');

test('a CI-stamped package.json yields a version+sha label', () => {
  const info = readBuildInfo({ version: '1.1.0-capture.20', kernBuild: {
    sha: '1E09E1EDFACF3517E7157CCB431F91BE57BE815F', run: '20', builtAt: '2026-09-22T09:00:00Z' } });
  assert.deepEqual(info, { version: '1.1.0-capture.20', sha: '1e09e1e', run: 20, builtAt: '2026-09-22T09:00:00Z', label: '1.1.0-capture.20+1e09e1e' });
});

test('an unstamped or malformed package.json reports dev, never throws', () => {
  assert.equal(readBuildInfo({ version: '1.0.3' }).label, '1.0.3+dev');
  assert.equal(readBuildInfo({ version: '1.0.3', kernBuild: { sha: 'not a sha', run: -1 } }).label, '1.0.3+dev');
  assert.equal(readBuildInfo({}).label, '0.0.0+dev');
  assert.equal(readBuildInfo({ version: '1.0.3', kernBuild: 'junk' }).run, null);
});

test('the real package.json produces a label the helper accepts', () => {
  // Mirrors HelperOptions: letters, digits, - _ . + only, at most 100 chars.
  assert.match(readBuildInfo().label, /^[A-Za-z0-9._+-]{1,100}$/);
});

test('supervisor status carries the build label and it survives helper status merges', () => {
  const supervisor = new RecorderSupervisor({ recordingsRoot: os.tmpdir(), helperPath: '/helper', platform: 'linux',
    buildInfo: readBuildInfo({ version: '1.1.0-capture.20', kernBuild: { sha: '1e09e1e' } }) });
  assert.equal(supervisor.snapshot().build, '1.1.0-capture.20+1e09e1e');
  supervisor._setStatus({ state: 'recording', build: 'spoofed-by-helper' });
  assert.equal(supervisor.snapshot().build, '1.1.0-capture.20+1e09e1e');
  assert.equal(supervisor.snapshot().state, 'recording');
});
