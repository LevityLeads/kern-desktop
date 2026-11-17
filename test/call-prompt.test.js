'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCallPrompt, displayName } = require('../recorder/call-prompt');

const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function rig({ callPrompt = true, noticeAcknowledged = true, startImpl } = {}) {
  const shown = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; this.closed = false; }
    show() { shown.push(this); }
    close() { this.closed = true; }
  }
  const watcher = Object.assign(new EventEmitter(), { start() { this.started = true; }, stop() { this.stopped = true; } });
  const supervisor = Object.assign(new EventEmitter(), {
    sessionId: null, stops: 0,
    isActive() { return this.sessionId !== null; },
    snapshot() { return { sessionId: this.sessionId }; },
    async stop() { this.stops += 1; const id = this.sessionId; this.sessionId = null; this.emit('ended', { sessionId: id }); },
  });
  const state = { callPrompt, noticeAcknowledged };
  const started = [];
  const recorderShown = [];
  const prompt = createCallPrompt({
    watcher, supervisor, Notification: FakeNotification, log: { error() {} },
    settings: { get: () => state },
    start: startImpl || (async () => { started.push(1); supervisor.sessionId = SESSION; return { sessionId: SESSION }; }),
    showRecorder: () => recorderShown.push(1),
    now: () => clock.t,
    setTicker: () => ({ unref() {} }), clearTicker: () => {},
  });
  const clock = { t: 0 };
  prompt.start();
  const mic = (apps, t) => { clock.t = t; watcher.emit('apps', apps); };
  const call = (name = 'ms-teams') => { mic([{ pid: 1, name }], 0); mic([{ pid: 1, name }], 3000); };
  return { prompt, watcher, supervisor, shown, started, recorderShown, state, mic, call, clock };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('display names', () => {
  assert.deepEqual(['ms-teams', 'ms-teams_modulehost', 'msteams', 'teams', 'zoom', 'chrome', 'msedge'].map(displayName),
    ['Teams', 'Teams', 'Teams', 'Teams', 'Zoom', 'Chrome', 'Edge']);
});

test('starts the watcher', () => {
  assert.equal(rig().watcher.started, true);
});

test('a call starting while idle shows one prompt with the exact copy', () => {
  const r = rig();
  r.call();
  assert.equal(r.shown.length, 1);
  assert.deepEqual(r.shown[0].options, { title: 'Record this call?', body: 'Teams is using your microphone. Click to record.' });
  assert.equal(r.started.length, 0);
  assert.doesNotMatch(JSON.stringify(r.shown[0].options), /[–—]/);
});

test('the prompt names the app', () => {
  const r = rig();
  r.call('msedge');
  assert.equal(r.shown[0].options.body, 'Edge is using your microphone. Click to record.');
});

test('a click starts recording once, a double click still starts once', async () => {
  const r = rig();
  r.call();
  r.shown[0].emit('click');
  r.shown[0].emit('click');
  await flush();
  assert.equal(r.started.length, 1);
  assert.equal(r.recorderShown.length, 0);
});

test('callPrompt off shows nothing', () => {
  const r = rig({ callPrompt: false });
  r.call();
  assert.equal(r.shown.length, 0);
});

test('already recording shows nothing', () => {
  const r = rig();
  r.supervisor.sessionId = 'other';
  r.call();
  assert.equal(r.shown.length, 0);
});

test('notice not acknowledged: the click opens the recorder window and does not start', async () => {
  const r = rig({ noticeAcknowledged: false });
  r.call();
  assert.equal(r.shown.length, 1);
  r.shown[0].emit('click');
  await flush();
  assert.equal(r.started.length, 0);
  assert.equal(r.recorderShown.length, 1);
});

test('a click after a manual recording began starts nothing', async () => {
  const r = rig();
  r.call();
  r.supervisor.sessionId = 'manual';
  r.shown[0].emit('click');
  await flush();
  assert.equal(r.started.length, 0);
});

test('a start failure opens the recorder window', async () => {
  const r = rig({ startImpl: async () => { throw new Error('no mic'); } });
  r.call();
  r.shown[0].emit('click');
  await flush();
  assert.equal(r.recorderShown.length, 1);
});

test('call-ended stops a prompt-started recording and says so', async () => {
  const r = rig();
  r.call();
  r.shown[0].emit('click');
  await flush();
  r.mic([], 10000);
  r.mic([], 3000 + 90000);
  await flush();
  assert.equal(r.supervisor.stops, 1);
  assert.equal(r.shown.at(-1).options.title, 'Call ended. Recording stopped.');
  assert.doesNotMatch(JSON.stringify(r.shown.at(-1).options), /[–—]/);
});

test('call-ended leaves a manual recording running', async () => {
  const r = rig();
  r.call();
  r.supervisor.sessionId = 'manual'; // the user pressed Start in the window instead
  r.mic([], 3000 + 90000);
  await flush();
  assert.equal(r.supervisor.stops, 0);
  assert.equal(r.supervisor.isActive(), true);
});

test('a prompt recording the user stopped by hand is not touched, nor is a later manual one', async () => {
  const r = rig();
  r.call();
  r.shown[0].emit('click');
  await flush();
  r.supervisor.sessionId = null;
  r.supervisor.emit('ended', { sessionId: SESSION });
  r.supervisor.sessionId = 'manual-2';
  r.mic([], 3000 + 90000);
  await flush();
  assert.equal(r.supervisor.stops, 0);
});

test('call-ended withdraws an unanswered prompt so a late click starts nothing', async () => {
  const r = rig();
  r.call();
  r.mic([], 3000 + 90000);
  assert.equal(r.shown[0].closed, true);
  r.shown[0].emit('click');
  await flush();
  assert.equal(r.started.length, 0);
});

test('Kern itself never prompts', () => {
  const r = rig();
  for (let t = 0; t < 20000; t += 1000) r.mic([{ pid: 9, name: 'kern' }, { pid: 8, name: 'kern.recorder.helper' }], t);
  assert.equal(r.shown.length, 0);
});

test('stop() stops the watcher', () => {
  const r = rig();
  r.prompt.stop();
  assert.equal(r.watcher.stopped, true);
});
