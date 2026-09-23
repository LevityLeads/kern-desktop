'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { RecorderSupervisor, TIMEOUTS } = require('../recorder/supervisor');
const { Liveness } = require('../recorder/liveness');
const { tempRoot } = require('./helpers');

function helperStatus(sessionId, state, extra = {}) {
  return {
    state, sessionId, startedAtUtc: '2026-09-22T10:00:00.000Z', elapsedMs: 60000, committedFrames: 58 * 16000,
    micMuted: false, playbackMode: 'devices', failure: null, warning: null,
    sources: [
      { id: 'microphone', lane: 'me', name: 'FIFINE', mode: 'microphone', state: 'active', level: 0.4, message: null, stats: {} },
      { id: 'playback-0123456789ab', lane: 'them', name: 'Speakers', mode: 'endpoint-loopback', state: 'active', level: 0.2, message: null, stats: {} },
    ],
    ...extra,
  };
}

// A scripted helper: `respond(command, payload)` returns the reply (or a promise of one).
class FakeHelper extends EventEmitter {
  constructor(respond) {
    super();
    this.respond = respond;
    this.commands = [];
    this.inFlight = 0;
    this.terminated = false;
  }
  async request(command, payload, timeoutMs) {
    this.commands.push({ command, payload, timeoutMs });
    this.inFlight += command === 'ping' ? 0 : 1;
    try { return await this.respond(command, payload); } finally { this.inFlight -= command === 'ping' ? 0 : 1; }
  }
  hasCommandInFlight() { return this.inFlight > 0; }
  async shutdown() { this.terminated = true; }
  async terminate() { this.terminated = true; }
}

async function recording(t, respond = () => ({})) {
  let now = 1_000_000;
  const events = { started: [], ended: [] };
  let helper;
  const supervisor = new RecorderSupervisor({
    recordingsRoot: tempRoot(t), helperPath: 'unused', platform: 'win32', now: () => now,
    launchHelper: async () => {
      helper = new FakeHelper((command, payload) => {
        if (command === 'start') return helperStatus(payload.sessionId, 'recording');
        return respond(command, payload, supervisor.status.sessionId);
      });
      return helper;
    },
  });
  supervisor.on('started', (e) => events.started.push(e));
  supervisor.on('ended', (e) => events.ended.push(e));
  await supervisor.start({ microphone: { mode: 'default' }, context: { transcribe: true } });
  clearInterval(supervisor.heartbeat);
  return { supervisor, helper, events, advance: (ms) => { now += ms; }, id: supervisor.status.sessionId };
}

test('liveness: silence is judged only after 15 s, never across a frozen timer or a command in flight', () => {
  let now = 0;
  const liveness = new Liveness({ now: () => now });
  for (let i = 0; i < 7; i += 1) { now += 2000; assert.equal(liveness.check(), 'ok'); }
  now += 2000;
  assert.equal(liveness.check({ commandInFlight: true }), 'ok');
  now += 2000;
  assert.equal(liveness.check(), 'hung');
  liveness.activity();
  now += 60000;
  assert.equal(liveness.check(), 'ok', 'a 60 s gap between ticks means our own process was frozen');
});

test('status events keep a recording alive even when pings never come back', async (t) => {
  const r = await recording(t, (command) => (command === 'ping' ? new Promise(() => {}) : {}));
  for (let ms = 0; ms < 60000; ms += 500) {
    r.advance(500);
    r.helper.emit('message');
    r.helper.emit('event', 'status', helperStatus(r.id, 'recording'));
    if (ms % 2000 === 0) r.supervisor._tick();
  }
  assert.equal(r.supervisor.status.state, 'recording');
  assert.equal(r.helper.terminated, false);
  assert.equal(r.helper.commands.filter(c => c.command === 'ping').length, 1, 'one ping at a time');
});

test('a slow command is not a hang; real silence afterwards is, and ends the call once', async (t) => {
  let release;
  const r = await recording(t, (command) => (command === 'pause' ? new Promise((resolve) => { release = resolve; }) : new Promise(() => {})));
  const pause = r.supervisor.pause();
  for (let i = 0; i < 9; i += 1) { r.advance(2000); r.supervisor._tick(); }
  assert.equal(r.supervisor.status.state, 'recording');
  release(helperStatus(r.id, 'paused'));
  await pause;
  assert.equal(r.supervisor.status.state, 'paused');
  for (let i = 0; i < 8; i += 1) { r.advance(2000); r.supervisor._tick(); }
  assert.equal(r.supervisor.status.state, 'interrupted');
  assert.equal(r.supervisor.status.failure.code, 'helper-hung');
  assert.equal(r.helper.terminated, true);
  assert.deepEqual(r.events.ended.map(e => e.sessionId), [r.id]);
});

test('a refused command is reported but never ends the recording', async (t) => {
  const r = await recording(t, (command) => {
    if (command === 'mute-mic') throw Object.assign(new Error('Microphone busy'), { code: 'helper-error' });
    return {};
  });
  await assert.rejects(r.supervisor.setMicMuted(true), /Microphone busy/);
  assert.equal(r.supervisor.status.state, 'recording');
  assert.equal(r.helper.terminated, false);
  assert.equal(r.helper.commands.find(c => c.command === 'mute-mic').timeoutMs, TIMEOUTS.control);
});

test('start: "started" only after the helper confirms, with the consent snapshot', async (t) => {
  const r = await recording(t);
  assert.deepEqual(r.events.started, [{ sessionId: r.id, context: { transcribe: true } }]);
  const start = r.helper.commands.find(c => c.command === 'start');
  assert.deepEqual(Object.keys(start.payload).sort(), ['microphone', 'sessionId', 'sessionPath']);
  assert.equal(start.timeoutMs, TIMEOUTS.start);
});

test('short sleep: the call pauses on suspend and resumes by itself on wake', async (t) => {
  const r = await recording(t, (command, _payload, id) => ({
    suspend: helperStatus(id, 'paused'), resume: helperStatus(id, 'recording'),
  })[command] || {});
  r.supervisor.onSystemSuspend();
  await new Promise(setImmediate);
  assert.equal(r.supervisor.status.pausedBy, 'suspend');
  r.advance(3 * 60000);
  assert.equal(await r.supervisor.onSystemResume(), 'resume');
  assert.equal(r.supervisor.status.state, 'recording');
  assert.equal(r.supervisor.status.pausedBy, null);
  assert.deepEqual(r.events.ended, []);
});

test('long sleep: the call is stopped on wake and trimmed to when the machine slept', async (t) => {
  const r = await recording(t, (command, _payload, id) => ({
    suspend: helperStatus(id, 'paused'), stop: helperStatus(id, 'stopped'),
  })[command] || {});
  r.supervisor.onSystemSuspend();
  await new Promise(setImmediate);
  r.advance(45 * 60000);
  assert.equal(await r.supervisor.onSystemResume(), 'stop');
  assert.equal(r.supervisor.status.state, 'stopped');
  assert.equal(r.events.ended.length, 1);
  assert.equal(r.events.ended[0].cutAtFrames, 60000 * 16 + 32000);
});

test('a pause the user chose survives sleep and wake untouched', async (t) => {
  const r = await recording(t, (command, _payload, id) => (command === 'pause' ? helperStatus(id, 'paused') : {}));
  await r.supervisor.pause();
  r.supervisor.onSystemSuspend();
  r.advance(60000);
  assert.equal(await r.supervisor.onSystemResume(), 'none');
  assert.equal(r.supervisor.status.state, 'paused');
  assert.equal(r.helper.commands.some(c => c.command === 'suspend' || c.command === 'resume'), false);
});

test('helper crash mid-call interrupts and ends the call exactly once', async (t) => {
  const r = await recording(t);
  r.helper.emit('failure', new Error('Capture helper exited (3)'));
  r.helper.emit('failure', new Error('again'));
  assert.equal(r.supervisor.status.state, 'interrupted');
  assert.equal(r.events.ended.length, 1);
});

test('stop and quit is bounded even if the helper never answers', async (t) => {
  const r = await recording(t, () => new Promise(() => {}));
  const started = Date.now();
  await r.supervisor.shutdownForQuit({ timeoutMs: 50 });
  assert.ok(Date.now() - started < 2000);
  assert.equal(r.helper.terminated, true);
  assert.equal(r.events.ended.length, 1);
});

test('non-Windows capture fails explicitly', async (t) => {
  const supervisor = new RecorderSupervisor({ recordingsRoot: tempRoot(t), helperPath: 'x', platform: 'linux' });
  await assert.rejects(supervisor.listDevices(), (error) => error.code === 'windows-only');
});
