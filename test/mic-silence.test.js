'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MicSilenceMonitor, SILENT_MS } = require('../recorder/mic-silence');

const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const status = ({ level = 0, state = 'recording', micMuted = false, sessionId = SESSION, micState = 'active' } = {}) => ({
  state, sessionId, micMuted,
  sources: [
    { id: 'microphone', lane: 'me', state: micState, level, name: 'Microphone (C922 Pro Stream Webcam)' },
    { id: 'playback', lane: 'them', state: 'active', level: 0.4, name: 'Speakers' },
  ],
});

test('a microphone that sends only silence for 20 seconds alerts once, naming it', () => {
  const m = new MicSilenceMonitor();
  assert.equal(m.update(status(), 0), null);
  assert.equal(m.update(status(), SILENT_MS - 1), null);
  assert.deepEqual(m.update(status(), SILENT_MS), { sessionId: SESSION, name: 'Microphone (C922 Pro Stream Webcam)' });
  assert.equal(m.update(status(), SILENT_MS * 3), null);
});

test('a microphone that carried any sound is trusted for the rest of the recording', () => {
  const m = new MicSilenceMonitor();
  m.update(status({ level: 0.0004 }), 0);
  for (let t = 1000; t < SILENT_MS * 5; t += 1000) assert.equal(m.update(status(), t), null);
});

test('silence while paused or muted in Kern does not count', () => {
  const m = new MicSilenceMonitor();
  m.update(status(), 0);
  m.update(status({ state: 'paused' }), SILENT_MS - 1000);
  assert.equal(m.update(status(), SILENT_MS + 1000), null); // the clock restarted at the resume
  m.update(status({ micMuted: true }), SILENT_MS + 2000);
  assert.equal(m.update(status(), SILENT_MS * 2), null);
  assert.ok(m.update(status(), SILENT_MS * 3 + 2000));
});

test('a new recording starts afresh', () => {
  const m = new MicSilenceMonitor();
  m.update(status(), 0);
  assert.ok(m.update(status(), SILENT_MS));
  const next = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  assert.equal(m.update(status({ sessionId: next }), SILENT_MS + 1), null);
  assert.ok(m.update(status({ sessionId: next }), SILENT_MS * 2 + 1));
});

test('no recording, or no microphone lane, never alerts', () => {
  const m = new MicSilenceMonitor();
  assert.equal(m.update({ state: 'idle', sessionId: null, sources: [] }, 0), null);
  const noMic = { state: 'recording', sessionId: SESSION, sources: [{ lane: 'them', state: 'active', level: 0 }] };
  m.update(noMic, 0);
  assert.equal(m.update(noMic, SILENT_MS * 2), null);
  m.update(status({ micState: 'failed' }), SILENT_MS * 3);
  assert.equal(m.update(status({ micState: 'failed' }), SILENT_MS * 5), null);
});
