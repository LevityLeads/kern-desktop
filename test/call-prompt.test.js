'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCallPrompt, displayName } = require('../recorder/call-prompt');

const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

// A stand-in for prompt-card.js: records what was shown and lets a test answer it.
function fakeCard({ throwOnShow = null } = {}) {
  return {
    shows: [], closes: 0, open: null,
    show(options) {
      if (throwOnShow) throw throwOnShow;
      this.shows.push(options);
      this.open = options;
    },
    close() { this.closes += 1; this.open = null; },
    // What the card page does: one answer, then the window is gone.
    answer(choice, options = this.shows.at(-1)) {
      if (this.open === options) this.open = null;
      return choice === 'record' ? options.onRecord() : options.onDismiss();
    },
  };
}

function rig({ callPrompt = true, noticeAcknowledged = true, startImpl, card = fakeCard() } = {}) {
  const notifications = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { notifications.push(this); }
    close() {}
  }
  const watcher = Object.assign(new EventEmitter(), {
    start() { this.started = true; }, stop() { this.stopped = true; },
    status() { return { running: true }; },
  });
  const supervisor = Object.assign(new EventEmitter(), {
    sessionId: null, stops: 0,
    isActive() { return this.sessionId !== null; },
    snapshot() { return { sessionId: this.sessionId }; },
    async stop() { this.stops += 1; const id = this.sessionId; this.sessionId = null; this.emit('ended', { sessionId: id }); },
  });
  const state = { callPrompt, noticeAcknowledged };
  const started = [];
  const recorderShown = [];
  const clock = { t: 0 };
  const prompt = createCallPrompt({
    watcher, card, supervisor, Notification: FakeNotification, log: { error() {} },
    settings: { get: () => state },
    start: startImpl || (async () => {
      started.push(1);
      supervisor.sessionId = SESSION;
      supervisor.emit('started', { sessionId: SESSION });
      return { sessionId: SESSION };
    }),
    showRecorder: () => recorderShown.push(1),
    now: () => clock.t,
    setTicker: () => ({ unref() {} }), clearTicker: () => {},
  });
  prompt.start();
  const mic = (apps, t) => { clock.t = t; watcher.emit('apps', apps); };
  const call = (name = 'ms-teams') => { mic([{ pid: 1, name }], 0); mic([{ pid: 1, name }], 3000); };
  return { prompt, watcher, supervisor, card, notifications, started, recorderShown, state, mic, call, clock };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('display names', () => {
  assert.deepEqual(['ms-teams', 'ms-teams_modulehost', 'msteams', 'teams', 'zoom', 'chrome', 'msedge'].map(displayName),
    ['Teams', 'Teams', 'Teams', 'Teams', 'Zoom', 'Chrome', 'Edge']);
});

test('starts the watcher', () => {
  assert.equal(rig().watcher.started, true);
});

test('a call starting while idle shows one card naming the app, and no Windows notification', () => {
  const r = rig();
  r.call('chrome');
  assert.equal(r.card.shows.length, 1);
  assert.equal(r.card.shows[0].app, 'Chrome');
  assert.equal(r.notifications.length, 0);
  assert.equal(r.started.length, 0);
});

test('a mic hold under 3 seconds shows nothing', () => {
  const r = rig();
  r.mic([{ pid: 1, name: 'chrome' }], 0);
  r.mic([{ pid: 1, name: 'chrome' }], 2000);
  r.mic([], 2500);
  assert.equal(r.card.shows.length, 0);
});

test('Record starts recording once, a second answer starts nothing', async () => {
  const r = rig();
  r.call();
  const shown = r.card.shows[0];
  r.card.answer('record', shown);
  r.card.answer('record', shown);
  await flush();
  assert.equal(r.started.length, 1);
  assert.equal(r.recorderShown.length, 0);
});

test('Not now holds for the rest of the call and the next call asks again', () => {
  const r = rig();
  r.call();
  r.card.answer('dismiss');
  for (let t = 4000; t < 60000; t += 1000) r.mic([{ pid: 1, name: 'ms-teams' }], t);
  assert.equal(r.card.shows.length, 1);
  r.mic([], 60000 + 90000); // the call ends
  r.mic([{ pid: 2, name: 'zoom' }], 200000);
  r.mic([{ pid: 2, name: 'zoom' }], 203000);
  assert.equal(r.card.shows.length, 2);
  assert.equal(r.card.shows[1].app, 'Zoom');
});

test('callPrompt off shows nothing and says why in diagnostics', () => {
  const r = rig({ callPrompt: false });
  r.call();
  assert.equal(r.card.shows.length, 0);
  assert.equal(r.prompt.diagnostics().last.outcome, 'skipped: prompt turned off');
});

test('already recording shows nothing', () => {
  const r = rig();
  r.supervisor.sessionId = 'other';
  r.call();
  assert.equal(r.card.shows.length, 0);
});

test('notice not acknowledged: Record opens the recorder window and does not start', async () => {
  const r = rig({ noticeAcknowledged: false });
  r.call();
  r.card.answer('record');
  await flush();
  assert.equal(r.started.length, 0);
  assert.equal(r.recorderShown.length, 1);
});

test('a recording started from the window withdraws the open card, so a late Record starts nothing', async () => {
  const r = rig();
  r.call();
  const shown = r.card.shows[0];
  r.supervisor.sessionId = 'manual';
  r.supervisor.emit('started', { sessionId: 'manual' });
  assert.equal(r.card.open, null);
  assert.equal(r.card.closes, 1);
  shown.onRecord();
  await flush();
  assert.equal(r.started.length, 0);
  assert.match(r.prompt.diagnostics().last.outcome, /recording started elsewhere/);
});

test('a start failure opens the recorder window', async () => {
  const r = rig({ startImpl: async () => { throw new Error('no mic'); } });
  r.call();
  r.card.answer('record');
  await flush();
  assert.equal(r.recorderShown.length, 1);
  assert.match(r.prompt.diagnostics().last.outcome, /record failed: no mic/);
});

test('a card that cannot open is logged in diagnostics and the next call tries again', () => {
  const r = rig({ card: fakeCard({ throwOnShow: new Error('no display') }) });
  r.call();
  assert.match(r.prompt.diagnostics().last.outcome, /card failed: no display/);
  assert.equal(r.prompt.diagnostics().cardOpen, false);
});

test('call-ended stops a card-started recording and says so', async () => {
  const r = rig();
  r.call();
  r.card.answer('record');
  await flush();
  r.mic([], 10000);
  r.mic([], 3000 + 90000);
  await flush();
  assert.equal(r.supervisor.stops, 1);
  assert.equal(r.notifications.at(-1).options.title, 'Call ended. Recording stopped.');
  assert.doesNotMatch(JSON.stringify(r.notifications.at(-1).options), /[–—]/);
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

test('a card recording the user stopped by hand is not touched, nor is a later manual one', async () => {
  const r = rig();
  r.call();
  r.card.answer('record');
  await flush();
  r.supervisor.sessionId = null;
  r.supervisor.emit('ended', { sessionId: SESSION });
  r.supervisor.sessionId = 'manual-2';
  r.mic([], 3000 + 90000);
  await flush();
  assert.equal(r.supervisor.stops, 0);
});

test('call-ended withdraws an unanswered card so a late Record starts nothing', async () => {
  const r = rig();
  r.call();
  const shown = r.card.shows[0];
  r.mic([], 3000 + 90000);
  assert.equal(r.card.open, null);
  shown.onRecord();
  await flush();
  assert.equal(r.started.length, 0);
  assert.equal(r.prompt.diagnostics().last.outcome, 'withdrawn: call ended');
});

test('Kern itself never prompts', () => {
  const r = rig();
  for (let t = 0; t < 20000; t += 1000) r.mic([{ pid: 9, name: 'kern' }, { pid: 8, name: 'kern.recorder.helper' }], t);
  assert.equal(r.card.shows.length, 0);
});

test('diagnostics name the mic holders, the watcher, the call and the last decision', () => {
  const r = rig();
  r.clock.t = Date.UTC(2026, 10, 17, 19, 0, 0);
  const base = r.clock.t;
  r.mic([{ pid: 1, name: 'svchost' }, { pid: 2, name: 'chrome' }], base);
  r.mic([{ pid: 1, name: 'svchost' }, { pid: 2, name: 'chrome' }], base + 3000);
  const d = r.prompt.diagnostics();
  assert.deepEqual(d.micHolders, ['svchost', 'chrome']);
  assert.deepEqual(d.watcher, { running: true });
  assert.equal(d.detector.inCall, true);
  assert.equal(d.detector.app, 'chrome');
  assert.equal(d.detector.lastHeldAt, '2026-11-17T19:00:03.000Z');
  assert.equal(d.cardOpen, true);
  assert.deepEqual(d.last, { at: '2026-11-17T19:00:03.000Z', app: 'chrome', outcome: 'shown' });
  JSON.stringify(d); // must serialise for the clipboard
});

test('stop() stops the watcher and withdraws the card', () => {
  const r = rig();
  r.call();
  r.prompt.stop();
  assert.equal(r.watcher.stopped, true);
  assert.equal(r.card.open, null);
});
