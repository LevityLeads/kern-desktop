'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CallHttp } = require('../recorder/call-http');
const { CallPipeline } = require('../recorder/call-pipeline');
const { MAX_DELAY_MS } = require('../recorder/retry-policy');
const { ORIGIN, OTHER_REMOTE, REMOTE, SESSION, appendFrames, fakeKern, json, tempRoot, writeSession } = require('./helpers');

const OTHER = '0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a';

// A pipeline on a temp folder, a fake Kern, manual timers and a controllable "helper".
function harness(t, { kern = fakeKern(), root = tempRoot(t) } = {}) {
  let capture = null;
  let clock = 1_000_000;
  const completed = [];
  const summaries = [];
  const http = new CallHttp({ getSession: () => kern.session, getOrigin: () => ORIGIN, fetchImpl: kern.upload });
  const pipeline = new CallPipeline({
    root, http, defaultTranscribe: () => true, now: () => clock,
    live: (id) => (capture?.sessionId === id ? { committedFrames: capture.committedFrames } : null),
    setTimer: (fn, ms) => ({ fn, ms }), clearTimer: () => {},
  });
  pipeline.on('complete', ({ sessionId }) => completed.push(sessionId));
  pipeline.on('summary', ({ sessionId }) => summaries.push(sessionId));
  return {
    root, kern, pipeline, completed, summaries,
    capture(sessionId, committedFrames) { capture = sessionId ? { sessionId, committedFrames } : null; },
    advance(ms) { clock += ms; },
    delay: (id) => pipeline.timers.get(id)?.ms ?? null,
    // Runs the scheduled pass for a call, as its timer would.
    async fire(id = SESSION) {
      const timer = pipeline.timers.get(id);
      assert.ok(timer, `no pass scheduled for ${id}`);
      timer.fn();
      await pipeline.locks.get(id);
    },
    state: (id = SESSION) => JSON.parse(fs.readFileSync(path.join(root, id, 'call.json'), 'utf8')),
  };
}

test('live call: windows publish during the call, the rest after stop, then Kern finishes, the transcript is NOT downloaded and audio is deleted', async (t) => {
  const h = harness(t);
  writeSession(h.root, { state: 'recording', frames: 130000 * 16 });
  h.capture(SESSION, 130000 * 16);
  await h.pipeline.onStarted(SESSION, { transcribe: true });
  await h.fire();
  assert.deepEqual([...h.kern.windows.keys()], [0, 1]);
  assert.equal(h.kern.uploaded.size, 2);
  assert.equal(h.delay(SESSION), 5000);
  // Every window was registered before its upload permission was asked for.
  const calls = h.kern.calls.filter(c => /windows|upload/.test(c)).map(c => c.split('/').pop());
  assert.deepEqual(calls, ['windows', 'upload', 'windows', 'upload']);

  appendFrames(h.root, 130000 * 16, 500 * 16 + 5);
  h.capture(null);
  await h.pipeline.onEnded({ sessionId: SESSION, context: { transcribe: true } });
  // Stop-and-quit waits on exactly this: the final length is on disk once onEnded resolves.
  assert.equal(h.state().finalFrames, 130500 * 16);
  await h.fire();
  assert.equal(h.kern.finalized.durationMs, 130500);
  assert.deepEqual(h.kern.finalized.objects.map(o => [o.windowIndex, o.startMs, o.endMs]),
    [[0, 0, 61000], [1, 59000, 121000], [2, 119000, 130500]]);
  assert.equal(h.kern.puts.length, 3);
  assert.equal(h.state().stage, 'transcribing');

  h.kern.state = 'complete';
  await h.fire();
  const done = h.state();
  assert.equal(done.stage, 'complete');
  assert.equal(done.transcript, undefined);
  assert.equal(h.kern.calls.some(c => c.includes('/transcript')), false, 'completion makes no transcript request');
  assert.equal(done.audioDeleted, true);
  assert.equal(fs.existsSync(path.join(h.root, SESSION, 'audio.pcm')), false);
  assert.equal(fs.existsSync(path.join(h.root, SESSION, 'session.json')), true);
  assert.deepEqual(h.completed, [SESSION]);
  // No summary thread yet: nothing is announced, and the pipeline keeps looking.
  assert.deepEqual(h.summaries, []);
  assert.equal(h.delay(SESSION), 60000);
});

test('restart mid-call resumes where it stopped: no window is sent twice', async (t) => {
  const first = harness(t);
  writeSession(first.root, { state: 'recording', frames: 70000 * 16 });
  first.capture(SESSION, 70000 * 16);
  await first.pipeline.onStarted(SESSION, { transcribe: true });
  await first.fire();
  assert.equal(first.kern.uploaded.size, 1);

  appendFrames(first.root, 70000 * 16, 130000 * 16);
  const second = harness(t, { kern: first.kern, root: first.root });
  second.capture(SESSION, 200000 * 16);
  await second.pipeline.run(SESSION);
  const counts = {};
  for (const put of first.kern.puts) counts[put.objectId] = (counts[put.objectId] || 0) + 1;
  assert.deepEqual(Object.values(counts), [1, 1, 1]);
  assert.equal(second.state().windows.length, 3);
});

test('restart mid-upload: a registered window is re-sent identically; a lost acknowledgement counts as uploaded', async (t) => {
  const h = harness(t);
  writeSession(h.root, { state: 'recording', frames: 125000 * 16 });
  h.capture(SESSION, 125000 * 16);
  let failed = 0;
  // Window 1: the bytes reach storage but the reply is lost.
  h.kern.failUpload = (objectId) => {
    if (h.kern.windows.get(1)?.id !== objectId || failed++) return null;
    h.kern.uploaded.add(objectId);
    throw new TypeError('socket hang up');
  };
  await h.pipeline.onStarted(SESSION, { transcribe: true });
  await h.fire();
  const interrupted = h.state();
  assert.deepEqual(interrupted.windows.map(w => [w.registered, w.uploaded]), [[true, true], [true, false]]);
  assert.equal(interrupted.error.retry, true);

  const restarted = harness(t, { kern: h.kern, root: h.root });
  restarted.capture(SESSION, 125000 * 16);
  await restarted.pipeline.run(SESSION);
  const after = restarted.state();
  assert.deepEqual(after.windows.map(w => w.uploaded), [true, true]);
  assert.equal(after.windows[1].id, interrupted.windows[1].id);
  assert.equal(after.error, null);
});

test('launch: a session left "recording" by a crash is settled from its file size and finalized', async (t) => {
  const h = harness(t);
  writeSession(h.root, { state: 'recording', frames: 90250 * 16 + 9 });
  await h.pipeline.start();
  await h.fire();
  const state = h.state();
  assert.equal(state.endReason, 'interrupted');
  assert.equal(state.finalFrames, 90250 * 16);
  assert.equal(h.kern.finalized.durationMs, 90250);
  assert.equal(h.kern.finalized.objects.length, 2);
  assert.equal(state.stage, 'transcribing');
});

test('transient failures back off to five minutes and never give up; online retries at once', async (t) => {
  const h = harness(t);
  writeSession(h.root, { frames: 30000 * 16 });
  let down = true;
  h.kern.fail = () => (down ? json({ error: 'unavailable' }, 503) : null);
  await h.pipeline.start();
  const delays = [];
  for (let i = 0; i < 12; i += 1) { await h.fire(); delays.push(h.delay(SESSION)); }
  assert.deepEqual(delays.slice(0, 4), [2000, 4000, 8000, 16000]);
  assert.equal(Math.max(...delays), MAX_DELAY_MS);
  assert.equal(delays.at(-1), MAX_DELAY_MS);
  assert.equal(h.state().attempts, 12);
  assert.equal(h.state().stage, 'publishing');
  down = false;
  h.pipeline.kick();
  assert.equal(h.delay(SESSION), 0);
  await h.fire();
  assert.equal(h.state().stage, 'transcribing');
  assert.equal(h.state().error, null);
  assert.equal(h.state().attempts, 0);
});

test('signed out: the call waits as sign-in-required and resumes by itself after sign-in', async (t) => {
  const h = harness(t);
  writeSession(h.root, { frames: 30000 * 16 });
  let signedIn = false;
  h.kern.fail = (_method, pathname) => (!signedIn && pathname === '/api/calls/identity' ? json({ error: 'unauthorized' }, 401) : null);
  await h.pipeline.start();
  await h.fire();
  assert.equal(h.state().stage, 'sign-in-required');
  assert.equal(h.state().error.code, 'auth');
  signedIn = true;
  h.pipeline.kick();
  await h.fire();
  assert.equal(h.state().stage, 'transcribing');
  assert.equal(h.state().error, null);
});

test('a call Kern failed to transcribe is retried through POST /retry', async (t) => {
  const h = harness(t);
  writeSession(h.root, { frames: 30000 * 16 });
  await h.pipeline.start();
  h.kern.fail = (method, pathname) => (method === 'GET' && pathname === `/api/calls/${REMOTE}` && h.kern.finalized
    ? json({ id: REMOTE, state: 'failed' }) : null);
  await h.fire();
  assert.equal(h.state().stage, 'failed');
  assert.equal(h.state().cloudFailed, true);
  assert.equal(h.delay(SESSION), null);
  h.kern.fail = null;
  await h.pipeline.retry(SESSION);
  assert.equal(h.kern.retried, 1);
  await h.fire();
  assert.equal(h.state().stage, 'transcribing');
  assert.equal(h.state().cloudFailed, false);
});

test('calls are independent: one stuck call does not hold up another', async (t) => {
  const h = harness(t);
  writeSession(h.root, { id: OTHER, frames: 30000 * 16 });
  writeSession(h.root, { frames: 30000 * 16 });
  h.kern.fail = (_method, pathname) => (pathname.includes(OTHER_REMOTE) ? new Promise(() => {}) : null);
  await h.pipeline.start();
  h.pipeline.timers.get(OTHER).fn();
  await h.fire(SESSION);
  assert.equal(h.state().stage, 'transcribing');
  assert.equal(h.state(OTHER).stage, 'publishing');
});

test('a long sleep trims the call back to when the machine went to sleep', async (t) => {
  const h = harness(t);
  writeSession(h.root, { frames: 20 * 60000 * 16 });
  await h.pipeline.onEnded({ sessionId: SESSION, context: { transcribe: true }, cutAtFrames: 5 * 60000 * 16 + 9 });
  assert.equal(h.state().finalFrames, 5 * 60000 * 16);
});

test('a call recorded with transcription off stays local until asked', async (t) => {
  const h = harness(t);
  writeSession(h.root, { frames: 30000 * 16 });
  await h.pipeline.onEnded({ sessionId: SESSION, context: { transcribe: false } });
  await h.fire();
  assert.equal(h.state().stage, 'local');
  assert.equal(h.kern.calls.length, 0);
  await h.pipeline.retry(SESSION);
  await h.fire();
  assert.equal(h.state().stage, 'transcribing');
});

test('a start that failed before any audio leaves no folder behind', async (t) => {
  const h = harness(t);
  fs.mkdirSync(path.join(h.root, SESSION));
  await h.pipeline.onEnded({ sessionId: SESSION, context: { transcribe: true } });
  assert.equal(fs.existsSync(path.join(h.root, SESSION)), false);
});

test('stop and quit mid-upload: uploads are cancelled at once and the final length is still saved', async (t) => {
  const h = harness(t);
  writeSession(h.root, { state: 'recording', frames: 70000 * 16 });
  h.capture(SESSION, 70000 * 16);
  // Kern hangs on the window registration until the request is aborted.
  h.kern.fail = (_method, pathname, _body, init) => (pathname.endsWith('/windows')
    ? new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) : null);
  await h.pipeline.onStarted(SESSION, { transcribe: true });
  h.pipeline.timers.get(SESSION).fn();
  await new Promise((resolve) => setTimeout(resolve, 50));
  h.capture(null);
  const ended = h.pipeline.onEnded({ sessionId: SESSION, context: { transcribe: true } });
  const started = Date.now();
  await h.pipeline.close({ timeoutMs: 5000 });
  await ended;
  assert.ok(Date.now() - started < 1000);
  assert.equal(h.state().finalFrames, 70000 * 16);
  assert.equal(h.state().error, null, 'a cancellation is not recorded as a failure');
});

test('a refused seal resends every window once, then finalizes instead of stranding the call', async (t) => {
  const h = harness(t);
  writeSession(h.root, { state: 'stopped', frames: 70000 * 16 });
  await h.pipeline.onEnded({ sessionId: SESSION, context: { transcribe: true } });
  // Kern lost track of the uploads (e.g. storage rolled back) and refuses the first seal.
  let refused = false;
  h.kern.fail = (method, pathname) => {
    if (!refused && pathname.endsWith('/live-finalize')) { refused = true; h.kern.uploaded.clear(); return json({ error: 'call_incomplete' }, 409); }
    return null;
  };
  await h.fire();
  assert.equal(h.kern.finalized, null);
  assert.equal(h.state().stage === 'failed', false);
  assert.ok(h.state().windows.every(w => w.uploaded === false));
  await h.fire();
  assert.equal(h.kern.finalized.durationMs, 70000);
  assert.equal(h.state().stage, 'transcribing');
});

async function finishedCall(t, { url = null } = {}) {
  const h = harness(t);
  writeSession(h.root, { state: 'stopped', frames: 30000 * 16 });
  await h.pipeline.onEnded({ sessionId: SESSION, context: { transcribe: true } });
  await h.fire();
  h.kern.state = 'complete';
  h.kern.kernThreadUrl = url;
  await h.fire();
  return h;
}
const THREAD = `${ORIGIN}/threads/abc`;

test('the summary notification fires once, when the Kern thread first exists, and not again after a restart', async (t) => {
  const h = await finishedCall(t);
  assert.equal(h.state().stage, 'complete');
  assert.deepEqual(h.summaries, []);
  h.advance(60000);
  await h.fire();
  assert.deepEqual(h.summaries, []);
  h.kern.kernThreadUrl = THREAD;
  h.advance(60000);
  await h.fire();
  assert.deepEqual(h.summaries, [SESSION]);
  assert.equal(h.state().cloud.kernThreadUrl, THREAD);
  assert.ok(h.state().summaryNotifiedAt);
  assert.equal(h.delay(SESSION), null, 'polling stops once notified');

  const restarted = harness(t, { kern: h.kern, root: h.root });
  await restarted.pipeline.start();
  assert.equal(restarted.delay(SESSION), null, 'nothing is scheduled for a notified call');
  await restarted.pipeline.run(SESSION);
  assert.deepEqual(restarted.summaries, []);
});

test('a thread that already exists when Kern finishes is announced once, at completion', async (t) => {
  const h = await finishedCall(t, { url: THREAD });
  assert.deepEqual(h.summaries, [SESSION]);
  await h.pipeline.run(SESSION);
  assert.deepEqual(h.summaries, [SESSION]);
});

test('a restart before the summary exists keeps waiting, then announces once', async (t) => {
  const h = await finishedCall(t);
  const restarted = harness(t, { kern: h.kern, root: h.root });
  await restarted.pipeline.start();
  assert.equal(restarted.delay(SESSION), 0, 'the pending summary resumes polling');
  h.kern.kernThreadUrl = THREAD;
  await restarted.fire();
  assert.deepEqual(restarted.summaries, [SESSION]);
});

test('the summary is awaited for 4 hours, not longer', async (t) => {
  const h = await finishedCall(t);
  h.advance(4 * 60 * 60000 - 60000 - 1);
  await h.fire();
  assert.equal(h.delay(SESSION), 60000, 'still polling just inside 4 h');
  h.advance(60002);
  h.kern.kernThreadUrl = THREAD;
  await h.fire();
  assert.deepEqual(h.summaries, [], 'gave up after 4 h');
});

test('call.json from an older version loads: no summaryNotifiedAt, and its stored transcript is dropped on the next save', async (t) => {
  const h = await finishedCall(t);
  const old = h.state();
  delete old.summaryNotifiedAt;
  old.transcript = { windows: [{ index: 0, text: 'secret words', utterances: null, segments: null, error: null, silent: false }] };
  fs.writeFileSync(path.join(h.root, SESSION, 'call.json'), JSON.stringify(old));
  const loaded = await h.pipeline.store.load(SESSION);
  assert.equal(loaded.summaryNotifiedAt, null);
  assert.equal(loaded.transcript, undefined);
  await h.pipeline.store.save(loaded);
  assert.doesNotMatch(fs.readFileSync(path.join(h.root, SESSION, 'call.json'), 'utf8'), /secret words/);
});
