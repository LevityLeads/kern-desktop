const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { setupAutoUpdater, STARTUP_DELAY_MS, CHECK_INTERVAL_MS } = require('../updater');

function harness({ visible = true, notifications = true, busy = false } = {}) {
  const state = { busy };
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.installs = [];
  updater.checkForUpdates = () => { updater.checks++; return Promise.resolve(); };
  updater.quitAndInstall = (...args) => updater.installs.push(args);

  const win = new EventEmitter();
  win.visible = visible;
  win.isVisible = () => win.visible;
  win.isDestroyed = () => false;

  const shown = [];
  class FakeNotification extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; }
    show() { shown.push(this); }
    static isSupported() { return notifications; }
  }

  const timeouts = [];
  const intervals = [];
  const app = { isQuitting: false };
  const power = new EventEmitter();
  const api = setupAutoUpdater({
    autoUpdater: updater,
    app,
    powerMonitor: power,
    Notification: FakeNotification,
    getWindow: () => win,
    isBusy: () => state.busy,
    timers: {
      setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
      setInterval: (fn, ms) => intervals.push({ fn, ms }),
    },
    log: { log() {}, error() {} },
  });
  return { updater, win, shown, timeouts, intervals, app, power, api, state };
}

const tick = () => new Promise((r) => setImmediate(r));

test('checks at startup, on an interval, and on resume', async () => {
  const h = harness();
  assert.strictEqual(h.timeouts[0].ms, STARTUP_DELAY_MS);
  assert.strictEqual(h.intervals[0].ms, CHECK_INTERVAL_MS);
  h.timeouts[0].fn();
  h.intervals[0].fn();
  h.power.emit('resume');
  await tick();
  assert.strictEqual(h.updater.checks, 3);
});

test('installs silently and relaunches when the window is in the tray', () => {
  const h = harness({ visible: false });
  h.updater.emit('update-downloaded', { version: '9.9.9' });
  assert.deepStrictEqual(h.updater.installs, [[true, true]]);
  assert.strictEqual(h.app.isQuitting, true);
  assert.strictEqual(h.shown.length, 0);
});

test('visible window: notifies once, installs when hidden, never twice', () => {
  const h = harness({ visible: true });
  h.updater.emit('update-downloaded', { version: '9.9.9' });
  assert.strictEqual(h.updater.installs.length, 0);
  assert.strictEqual(h.shown.length, 1);
  assert.match(h.shown[0].opts.body, /9\.9\.9/);
  h.win.emit('hide');
  h.shown[0].emit('click');
  assert.deepStrictEqual(h.updater.installs, [[true, true]]);
});

test('notification click installs immediately', () => {
  const h = harness({ visible: true });
  h.updater.emit('update-downloaded', { version: '9.9.9' });
  h.shown[0].emit('click');
  assert.strictEqual(h.updater.installs.length, 1);
});

test('stops checking once an update is ready', async () => {
  const h = harness({ visible: true });
  h.updater.emit('update-downloaded', { version: '9.9.9' });
  h.intervals[0].fn();
  await tick();
  assert.strictEqual(h.updater.checks, 0);
});

test('a failed install resets so a later trigger can retry', () => {
  const h = harness({ visible: true });
  let fail = true;
  h.updater.quitAndInstall = (...a) => { if (fail) throw new Error('boom'); h.updater.installs.push(a); };
  h.updater.emit('update-downloaded', { version: '9.9.9' });
  h.shown[0].emit('click');
  assert.strictEqual(h.app.isQuitting, false);
  fail = false;
  h.win.emit('hide');
  assert.strictEqual(h.updater.installs.length, 1);
});

test('a failed check is logged, not thrown', async () => {
  const h = harness();
  h.updater.checkForUpdates = () => Promise.reject(new Error('offline'));
  h.timeouts[0].fn();
  await tick();
});

test('pins the stable channel regardless of the installed version', () => {
  const h = harness();
  assert.strictEqual(h.updater.allowPrerelease, false);
  assert.ok(!h.updater.channel);
});

test('does not install while recording, installs once when idle', () => {
  const h = harness({ visible: false, busy: true });
  h.updater.emit('update-downloaded', { version: '9.9.9' });
  assert.strictEqual(h.updater.installs.length, 0);
  assert.strictEqual(h.app.isQuitting, false);
  h.api.busyChanged();
  assert.strictEqual(h.updater.installs.length, 0);
  h.state.busy = false;
  h.api.busyChanged();
  h.api.busyChanged();
  assert.deepStrictEqual(h.updater.installs, [[true, true]]);
});

test('a click or hide while recording defers the install to idle', () => {
  const h = harness({ visible: true, busy: true });
  h.updater.emit('update-downloaded', { version: '9.9.9' });
  h.shown[0].emit('click');
  h.win.emit('hide');
  assert.strictEqual(h.updater.installs.length, 0);
  h.state.busy = false;
  h.api.busyChanged();
  assert.deepStrictEqual(h.updater.installs, [[true, true]], 'the click and hide asked for an install');
});

test('a hidden-window update waiting on a recording installs at idle', () => {
  const h = harness({ visible: true, busy: true });
  h.updater.emit('update-downloaded', { version: '9.9.9' });
  h.win.visible = false;
  h.state.busy = false;
  h.api.busyChanged();
  assert.strictEqual(h.updater.installs.length, 1);
});

test('does not download while recording and downloads at idle', async () => {
  const h = harness({ busy: true });
  let downloads = 0;
  h.updater.downloadUpdate = async () => { downloads++; };
  h.updater.emit('update-available', { version: '9.9.9' });
  await tick();
  assert.strictEqual(downloads, 0);
  h.state.busy = false;
  h.api.busyChanged();
  await tick();
  assert.strictEqual(downloads, 1);
});

test('a downloaded update never installs on app quit while recording', () => {
  const h = harness({ busy: true });
  h.updater.emit('update-downloaded', { version: '9.9.9' });
  assert.strictEqual(h.updater.autoInstallOnAppQuit, false);
});
