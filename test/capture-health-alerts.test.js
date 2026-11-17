'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CaptureHealthAlerts, presentCaptureAlert } = require('../recorder/capture-health-alerts');
const { trayItems, traySignature, trayTooltip } = require('../recorder/tray-model');
const { withRecordingDot } = require('../recorder/tray-icon');

const ID = '9b918241-3cb0-447c-8861-8f14358563e7';
const status = (state, extra = {}) => ({ state, sessionId: ID, failure: null, warning: null, elapsedMs: 754000, ...extra });

test('a recording that actually stopped brings the recorder forward once', () => {
  const alerts = new CaptureHealthAlerts();
  assert.equal(alerts.update(status('recording')), null);
  const alert = alerts.update(status('interrupted', { failure: { code: 'helper-hung', message: 'The recorder stopped responding.' } }));
  assert.equal(alert.focus, true);
  assert.match(alert.body, /Everything up to that point is saved/);
  assert.equal(alerts.update(status('interrupted', { failure: { code: 'helper-hung', message: 'x' } })), null);
});

test('a warning the helper is already fixing never steals focus, and only notifies if it lasts', () => {
  let now = 0;
  const alerts = new CaptureHealthAlerts({ now: () => now });
  const warning = { warning: 'Microphone disconnected. Reconnecting.' };
  assert.equal(alerts.update(status('recording', warning)), null);
  now += 3000;
  assert.equal(alerts.update(status('recording')), null, 'recovered within seconds: nothing to say');
  assert.equal(alerts.update(status('recording', warning)), null);
  now += 11000;
  const alert = alerts.update(status('recording', warning));
  assert.equal(alert.focus, false);
  now += 11000;
  assert.equal(alerts.update(status('recording', warning)), null, 'once per warning per call');
});

test('presenting an alert: focus only when asked, and OS errors never escape', () => {
  const shown = [];
  class Notification { static isSupported() { return true; } on() {} show() { throw new Error('toast failed'); } }
  const errors = [];
  presentCaptureAlert({ title: 't', body: 'b', focus: false }, { showRecorder: () => shown.push(1), Notification, reportError: (e) => errors.push(e) });
  assert.deepEqual(shown, []);
  presentCaptureAlert({ title: 't', body: 'b', focus: true }, { showRecorder: () => shown.push(1), Notification, reportError: (e) => errors.push(e) });
  assert.deepEqual(shown, [1]);
  assert.equal(errors.length, 2);
});

test('tray: tooltip shows the timer; the menu signature changes per state, not per tick', () => {
  assert.equal(trayTooltip(status('recording')), 'Kern: recording 12:34');
  assert.equal(trayTooltip(status('idle')), 'Kern');
  assert.equal(traySignature(status('recording')), traySignature(status('recording', { elapsedMs: 999000, levels: { me: 1 } })));
  assert.notEqual(traySignature(status('recording')), traySignature(status('paused')));
  assert.deepEqual(trayItems(status('paused')).map((i) => i.action), ['show', 'resume', 'stop']);
});

test('tray recording dot paints only the corner of the icon', () => {
  const bitmap = Buffer.alloc(16 * 16 * 4, 0x10);
  const out = withRecordingDot(bitmap, 16, 16);
  assert.equal(out.readUInt32LE(0), bitmap.readUInt32LE(0));
  const corner = (12 * 16 + 12) * 4;
  assert.deepEqual([...out.subarray(corner, corner + 4)], [0x3b, 0x3b, 0xe5, 0xff]);
});
