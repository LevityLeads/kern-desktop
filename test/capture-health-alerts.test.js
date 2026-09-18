'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CaptureHealthAlerts, presentCaptureAlert } = require('../recorder/capture-health-alerts');
const status = (render = 'healthy-idle', microphone = 'healthy-idle', extra = {}) => ({
  sessionId: 'one', state: 'recording', micMuted: false,
  tracks: [{ kind: 'render', health: render }, { kind: 'microphone', health: microphone }], ...extra,
});

test('silence is healthy; incoming loss alerts once then recovery warns of missing audio', () => {
  const alerts = new CaptureHealthAlerts();
  assert.equal(alerts.update(status()), null);
  assert.match(alerts.update(status('failed')).body, /Incoming audio unavailable/);
  assert.equal(alerts.update(status('failed')), null);
  assert.equal(alerts.update(status('recovering')), null);
  assert.match(alerts.update(status()).body, /Earlier audio may still be missing/);
  assert.equal(alerts.update(status()), null);
});

test('missing tracks warn; replacement excludes retired failure history', () => {
  const alerts = new CaptureHealthAlerts();
  assert.match(alerts.update(status('healthy', 'healthy', { tracks: [] })).body, /Incoming audio and Your microphone/);
  const recovered = status();
  recovered.tracks.push({ kind: 'render', health: 'failed', retired: true });
  assert.equal(alerts.update(recovered).title, 'Recording recovered');
});

test('pause and stop do not announce recovery, new sessions reset deduplication', () => {
  const alerts = new CaptureHealthAlerts();
  alerts.update(status('failed'));
  for (const state of ['paused', 'stopped', 'idle', 'starting']) {
    assert.equal(alerts.update(status('healthy', 'healthy', { state })), null);
  }
  assert.match(alerts.update(status('failed', 'healthy', { sessionId: 'two' })).body, /Incoming audio/);
});

test('intentional mute does not warn or falsely recover a failed microphone', () => {
  const alerts = new CaptureHealthAlerts();
  assert.equal(alerts.update(status('healthy', 'failed', { micMuted: true })), null);
  assert.match(alerts.update(status('healthy', 'failed')).body, /Your microphone/);
  assert.equal(alerts.update(status('healthy', 'failed', { micMuted: true })), null);
  assert.equal(alerts.update(status()).title, 'Recording recovered');
});

test('missing mic heartbeat warns, degraded replacement cannot announce recovery', () => {
  const alerts = new CaptureHealthAlerts();
  assert.match(alerts.update(status('healthy-idle', 'unknown')).body, /Your microphone/);
  assert.equal(alerts.update(status('healthy-idle', 'healthy-idle', { state: 'degraded' })), null);
  assert.equal(alerts.update(status()).title, 'Recording recovered');
});

test('muting and unmuting failed mic with native failure does not repeat alerts', () => {
  const alerts = new CaptureHealthAlerts();
  const failure = { code: 'track-failed', message: 'Microphone stopped' };
  assert.ok(alerts.update(status('healthy-idle', 'failed', { failure })));
  assert.equal(alerts.update(status('healthy-idle', 'failed', { failure, micMuted: true })), null);
  assert.equal(alerts.update(status('healthy-idle', 'failed', { failure })), null);
});

test('unexpected helper exit alerts even after tracks disappear', () => {
  const alerts = new CaptureHealthAlerts();
  const interrupted = status('healthy', 'healthy', { state: 'interrupted', failure: 'Helper exited', tracks: [] });
  assert.equal(alerts.update(interrupted).title, 'Recording interrupted');
  assert.equal(alerts.update(interrupted), null);
});

test('failure opens hidden recorder even when OS notifications are unavailable', () => {
  let shown = 0;
  const options = { showRecorder: () => shown++, Notification: { isSupported: () => false }, reportError: assert.fail };
  presentCaptureAlert({ title: 'Recording needs attention', body: 'Incoming audio unavailable' }, options);
  assert.equal(shown, 1);
  presentCaptureAlert({ title: 'Recording recovered', body: 'Earlier audio may be missing' }, options);
  assert.equal(shown, 1);
});

test('notification failures cannot interrupt capture status handling', () => {
  const errors = [];
  presentCaptureAlert({ title: 'Recording needs attention' }, {
    showRecorder() { throw new Error('window failed'); },
    Notification: { isSupported() { throw new Error('OS failed'); } },
    reportError: error => errors.push(error.message),
  });
  assert.deepEqual(errors, ['window failed', 'OS failed']);
});

test('a second failed side gets an alert; generic failure deduplicates', () => {
  const alerts = new CaptureHealthAlerts();
  alerts.update(status('failed'));
  assert.match(alerts.update(status('failed', 'failed')).body, /Your microphone/);
  assert.ok(alerts.update(status('healthy', 'healthy', { failure: 'disk error' })));
  assert.equal(alerts.update(status('healthy', 'healthy', { failure: 'disk error' })), null);
  assert.equal(alerts.update(null), null);
});
