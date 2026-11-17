'use strict';

const { EventEmitter } = require('node:events');
const catalog = require('./session-catalog');
const { CallStore, fresh } = require('./call-store');
const { runCall, settleEnd } = require('./call-runner');
const { fetchTranscript } = require('./call-cloud');
const { caller } = require('./call-publisher');
const { MAX_DELAY_MS, backoffDelay, classify, errorRecord } = require('./retry-policy');

// Runs every call independently: one timer and one lock per call, no shared queue, so a slow
// upload or a failing call never holds up another. Emits 'change' {sessionId} after every saved
// step and 'complete' {sessionId} when a transcript lands during this run of the app.
const TAIL_INTERVAL_MS = 15000;
const AUTH_LIVE_RETRY_MS = 60000;
const RESET_REMOTE = new Set(['remote-deleted', 'not-found']);
// Deleting a call locally may go ahead without Kern's copy only when that copy is already gone
// or belongs to a Kern this app is no longer connected to.
const LOCAL_DELETE_OK = new Set([...RESET_REMOTE, 'origin', 'origin-changed']);

class CallPipeline extends EventEmitter {
  // live(sessionId) -> { committedFrames } while the helper is capturing that call, else null.
  // defaultTranscribe() -> whether a call found without its own state should be transcribed.
  constructor({ root, http, live, defaultTranscribe = () => false, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    super();
    this.root = root;
    this.http = http;
    this.live = live;
    this.defaultTranscribe = defaultTranscribe;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.store = new CallStore(root);
    this.timers = new Map();
    this.locks = new Map();
    this.queued = new Set();
    this.waiting = new Set();
    this.damaged = new Map();
    this.tails = new Map();
    this.tailAt = new Map();
    this.abort = new AbortController();
    this.closed = false;
  }

  context(sessionId) {
    return {
      root: this.root, http: this.http, now: this.now, signal: this.abort.signal,
      live: id => this.live(id),
      audioFile: () => catalog.audioPath(this.root, sessionId),
      save: state => this.save(state),
      onComplete: state => this.emit('complete', { sessionId: state.sessionId }),
    };
  }

  async save(state) {
    await this.store.save(state);
    this.emit('change', { sessionId: state.sessionId });
  }

  lock(sessionId, action) {
    const previous = this.locks.get(sessionId) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.locks.set(sessionId, current);
    current.catch(() => {}).finally(() => { if (this.locks.get(sessionId) === current) this.locks.delete(sessionId); });
    return current;
  }

  schedule(sessionId, delayMs = 0) {
    if (this.closed) return;
    this.clearTimer(this.timers.get(sessionId));
    const timer = this.setTimer(() => { this.timers.delete(sessionId); this.run(sessionId); }, Math.max(0, delayMs));
    timer?.unref?.();
    this.timers.set(sessionId, timer);
  }

  run(sessionId) {
    if (this.closed || this.queued.has(sessionId)) return this.locks.get(sessionId);
    this.queued.add(sessionId);
    return this.lock(sessionId, async () => {
      this.queued.delete(sessionId);
      await this.pass(sessionId);
    });
  }

  async pass(sessionId) {
    if (this.closed) return;
    let state = null;
    try {
      state = await this.store.load(sessionId);
      this.damaged.delete(sessionId);
      if (!state) return;
      const next = await runCall(this.context(sessionId), state);
      this.waiting.delete(sessionId);
      if (state.error || state.attempts) {
        Object.assign(state, { error: null, attempts: 0, nextAttemptAt: 0 });
        await this.save(state);
      }
      if (next !== null) this.schedule(sessionId, next);
      await this.refreshTail(state);
    } catch (error) {
      await this.failed(sessionId, state, error).catch(() => {});
    }
  }

  async failed(sessionId, state, error) {
    const kind = classify(error);
    if (this.closed || kind === 'cancelled') return;
    const record = errorRecord(error, kind);
    if (!state) {
      // call.json itself is unreadable. Shown as failed; Retry rebuilds it from session.json.
      this.damaged.set(sessionId, record);
      this.emit('change', { sessionId });
      return;
    }
    // A finished call stays finished: housekeeping after the transcript (deleting audio) just retries.
    if (state.stage === 'complete') { this.schedule(sessionId, MAX_DELAY_MS); return; }
    const live = Boolean(this.live(sessionId));
    state.error = record;
    if (kind === 'retry') {
      const delay = backoffDelay(state.attempts);
      state.attempts += 1;
      state.nextAttemptAt = this.now() + delay;
      this.waiting.add(sessionId);
      this.schedule(sessionId, delay);
    } else if (kind === 'auth') {
      if (!live) state.stage = 'sign-in-required';
      this.waiting.add(sessionId);
      this.schedule(sessionId, live ? AUTH_LIVE_RETRY_MS : MAX_DELAY_MS);
    } else if (!live) {
      state.stage = 'failed';
    }
    await this.save(state);
  }

  // A best-effort look at what Kern has transcribed so far, for the "about a minute behind" tail.
  async refreshTail(state) {
    const id = state.sessionId;
    if (!['recording', 'transcribing'].includes(state.stage) || !state.remoteId || !state.windows.some(w => w.uploaded)) return;
    if (this.now() - (this.tailAt.get(id) || 0) < TAIL_INTERVAL_MS) return;
    this.tailAt.set(id, this.now());
    try {
      this.tails.set(id, await fetchTranscript(this.context(id), state));
      this.emit('change', { sessionId: id });
    } catch { /* the tail is a nicety; the final transcript is fetched separately */ }
  }

  tail(sessionId) { return this.tails.get(sessionId) || null; }
  damage(sessionId) { return this.damaged.get(sessionId) || null; }

  // App launch: every capture-v2 call that is not finished resumes; interrupted captures are
  // settled from their audio file and processed like any other ended call.
  async start() {
    for (const id of await catalog.listSessionIds(this.root)) {
      await this.lock(id, async () => {
        if ((await catalog.sessionKind(this.root, id)) !== 'v2') return;
        let state = await this.store.load(id);
        if (!state) {
          state = fresh(id, { transcribe: this.defaultTranscribe() });
          await this.save(state);
        }
        if (state.stage === 'failed' || (state.stage === 'complete' && state.audioDeleted)) return;
        this.schedule(id, 0);
      }).catch((error) => this.failed(id, null, error));
    }
  }

  async onStarted(sessionId, { transcribe }) {
    await this.lock(sessionId, async () => {
      if (!(await this.store.load(sessionId))) await this.save(fresh(sessionId, { transcribe }));
    });
    this.schedule(sessionId, 0);
  }

  // Resolves once the call's final length is saved (quit waits on this), then processing continues.
  async onEnded({ sessionId, context = null, cutAtFrames = null }) {
    this.clearTimer(this.timers.get(sessionId));
    const exists = await this.lock(sessionId, async () => {
      const kind = await catalog.sessionKind(this.root, sessionId)
        .catch((error) => (error.code === 'ENOENT' ? 'missing' : Promise.reject(error)));
      if (kind === 'missing') return false;
      if (kind === 'none') { await catalog.removeSession(this.root, sessionId); return false; }
      const transcribe = typeof context?.transcribe === 'boolean' ? context.transcribe : this.defaultTranscribe();
      const state = (await this.store.load(sessionId)) || fresh(sessionId, { transcribe });
      await settleEnd(this.context(sessionId), state, cutAtFrames);
      return true;
    });
    if (exists) this.schedule(sessionId, 0);
  }

  // Network back, wake from sleep, or a sign-in: everything waiting retries now.
  kick() {
    for (const id of this.waiting) this.schedule(id, 0);
  }

  async retry(sessionId) {
    await this.lock(sessionId, async () => {
      let state = await this.store.load(sessionId).catch(() => null);
      state ||= fresh(sessionId, { transcribe: true });
      this.damaged.delete(sessionId);
      if (state.stage === 'complete') return;
      const code = state.error?.code;
      Object.assign(state, { transcribe: true, error: null, attempts: 0, nextAttemptAt: 0 });
      if (state.cloudFailed && state.remoteId) {
        await caller(this.context(sessionId), state)(`/api/calls/${state.remoteId}/retry`, { method: 'POST' })
          .catch((error) => { if (error.code !== 'conflict') throw error; });
        state.cloudFailed = false;
        state.stage = 'transcribing';
      } else if (RESET_REMOTE.has(code)) {
        Object.assign(state, { remoteId: null, finalized: false, windows: [], cloud: fresh(sessionId).cloud });
      }
      if (['failed', 'local', 'sign-in-required'].includes(state.stage)) state.stage = 'publishing';
      await this.save(state);
    });
    this.schedule(sessionId, 0);
  }

  async rename(sessionId, title) {
    await this.lock(sessionId, async () => {
      const state = await this.store.load(sessionId);
      if (!state) throw new Error('Older recordings cannot be renamed.');
      state.title = title;
      await this.save(state);
    });
  }

  // Deletes the Kern copy first (so nothing is orphaned in the cloud), then the local folder.
  async remove(sessionId) {
    if (this.live(sessionId)) throw new Error('Stop the recording before deleting it.');
    await this.lock(sessionId, async () => {
      const state = await this.store.load(sessionId).catch(() => null);
      if (state?.remoteId) {
        await caller(this.context(sessionId), state)(`/api/calls/${state.remoteId}`, { method: 'DELETE' })
          .catch((error) => { if (!LOCAL_DELETE_OK.has(error.code)) throw error; });
      }
      this.clearTimer(this.timers.get(sessionId));
      this.timers.delete(sessionId);
      for (const map of [this.tails, this.tailAt, this.damaged]) map.delete(sessionId);
      this.waiting.delete(sessionId);
      await catalog.removeSession(this.root, sessionId);
    });
    this.emit('change', { sessionId });
  }

  async close({ timeoutMs = 3000 } = {}) {
    this.closed = true;
    this.abort.abort();
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    let timer;
    await Promise.race([
      Promise.allSettled([...this.locks.values()]),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
  }
}

module.exports = { CallPipeline, TAIL_INTERVAL_MS };
