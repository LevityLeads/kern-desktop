'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHelperStatus } = require('../recorder/helper-status');
const { wakeAction } = require('../recorder/power-policy');

const ID = '9b918241-3cb0-447c-8861-8f14358563e7';

test('protocol-2 status is normalized: lanes become You/Them levels, junk sources are dropped', () => {
  const status = normalizeHelperStatus({
    state: 'recording', sessionId: ID.toUpperCase(), startedAtUtc: '2026-09-22T10:00:00Z', elapsedMs: 5000, committedFrames: 56000,
    micMuted: false, playbackMode: 'devices', failure: null, warning: 'Microphone disconnected. Reconnecting.',
    sources: [
      { id: 'microphone', lane: 'me', name: 'FIFINE', mode: 'microphone', state: 'recovering', level: 0.3, message: null, stats: {} },
      { id: 'playback-0123456789ab', lane: 'them', name: 'Speakers', mode: 'endpoint-loopback', state: 'active', level: 7, message: null },
      { id: 'playback-0123456789ac', lane: 'them', name: 'Headset', mode: 'endpoint-loopback', state: 'active', level: 0.6, message: null },
      { id: '../evil', lane: 'them', name: 'x', mode: 'endpoint-loopback', state: 'active', level: 1 },
    ],
  });
  assert.equal(status.sessionId, ID);
  assert.deepEqual(status.levels, { me: 0.3, them: 1 });
  assert.equal(status.sources.length, 3);
  assert.equal(status.warning, 'Microphone disconnected. Reconnecting.');
});

test('failures keep a known code; anything that is not a protocol-2 status is ignored', () => {
  const failed = normalizeHelperStatus({ state: 'interrupted', sessionId: ID, sources: [],
    failure: { code: 'low-storage', message: 'Recording stopped because the disk is almost full.' } });
  assert.deepEqual(failed.failure, { code: 'low-storage', message: 'Recording stopped because the disk is almost full.' });
  assert.equal(normalizeHelperStatus({ state: 'suspended', sessionId: ID }), null);
  assert.equal(normalizeHelperStatus({ state: 'recording', sessionId: 'not-a-uuid' }), null);
  assert.equal(normalizeHelperStatus(null), null);
});

test('wake policy: resume a short sleep, end a long one, never touch a user pause', () => {
  assert.equal(wakeAction({ pausedBy: 'suspend', sleptMs: 9 * 60000, hasSession: true }), 'resume');
  assert.equal(wakeAction({ pausedBy: 'suspend', sleptMs: 10 * 60000, hasSession: true }), 'stop');
  assert.equal(wakeAction({ pausedBy: 'user', sleptMs: 60000, hasSession: true }), 'none');
  assert.equal(wakeAction({ pausedBy: 'suspend', sleptMs: 60000, hasSession: false }), 'none');
});
