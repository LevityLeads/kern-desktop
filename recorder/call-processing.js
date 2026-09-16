'use strict';

const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { CallState } = require('./call-state');
const { CallHttp } = require('./call-http');
const { CallError, safePath, sourceManifest } = require('./call-files');
const { validateDerived } = require('./call-derived');
const { processCall } = require('./call-work');

class CallProcessing extends EventEmitter {
  constructor({ recordingsRoot, helperPath, getSession, getOrigin, settingsPath, spawnProcess }) {
    super();
    this.store = new CallState(recordingsRoot, settingsPath);
    this.http = new CallHttp({ getSession, getOrigin });
    this.helperPath = helperPath;
    this.spawnProcess = spawnProcess;
    this.locks = new Map();
    this.queue = new Set();
    this.timers = new Map();
    this.running = null;
    this.abort = new AbortController();
    this.closed = false;
  }
  async start() {
    if (this.closed) return;
    for (const id of await this.store.pending()) {
      const state = await this.store.load(id);
      this.schedule(id, Math.max(0, (state.nextAttemptAt || 0) - Date.now()));
    }
  }
  async stop() {
    this.closed = true;
    this.abort.abort();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.queue.clear();
    await this.running?.catch(() => {});
  }
  async lock(id, action) {
    const previous = this.locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.locks.set(id, current);
    try { return await current; }
    finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  async save(state) {
    await this.store.save(state);
    this.emit('change', { sessionId: state.sessionId });
  }
  getTranscriptionEnabled() { return this.store.preference(); }
  setTranscriptionEnabled(enabled) { return this.store.setPreference(enabled); }
  // Read synchronously at capture start so a mid-call preference change never
  // retroactively enrolls or excludes a recording already under way.
  async snapshotStartConsent() {
    try { return await this.store.preference(); }
    catch { return { enabled: false }; }
  }
  // Main calls this exactly once for a newly started call, never for library discovery.
  async onStarted(id, snapshot = null) {
    return this.lock(id, async () => {
      const state = await this.store.load(id);
      if (state.state !== 'local') return;
      state.consent = snapshot ? snapshot.enabled === true : (await this.store.preference()).enabled;
      try { state.origin = state.consent ? this.http.origin() : null; }
      catch { state.origin = null; }
      state.state = 'recording';
      await this.save(state);
    });
  }
  async onStopped(id) {
    await this.lock(id, async () => {
      const state = await this.store.load(id);
      state.preparePending = true;
      state.state = 'preparing';
      state.requested ||= state.consent && !!state.origin && (await this.store.preference()).enabled;
      await this.save(state);
    });
    this.schedule(id);
  }
  async prepare(id) {
    await this.lock(id, async () => {
      const state = await this.store.load(id);
      // Do not disturb a call that is already prepared or being processed remotely.
      if (state.playbackReady || ['ready', 'uploading', 'transcribing', 'complete'].includes(state.state)) return;
      state.preparePending = true;
      state.state = 'preparing';
      state.error = null;
      await this.save(state);
      this.schedule(id);
    });
    return this.getCall(id);
  }
  async transcribe(id) {
    await this.lock(id, async () => {
      const state = await this.store.load(id);
      const origin = this.http.origin();
      // Existing remote bindings never move across Kern installations automatically.
      if (state.origin && state.origin !== origin) throw new CallError('origin-changed', 'This call belongs to another Kern connection.');
      state.consent = true;
      state.requested = true;
      state.cloudHold = false;
      state.explicitRetry = !!state.remoteId;
      state.origin = origin;
      state.state = 'preparing';
      state.error = null;
      state.retryCount = 0;
      state.nextAttemptAt = 0;
      await this.save(state);
    });
    this.schedule(id);
    return this.getCall(id);
  }
  async getCall(id) {
    const state = await this.store.load(id);
    let playbackUrl = null;
    // Do not hash an entire call on every status tick. Only explicit playback/export resolves it.
    if (state.playbackReady) {
      try {
        const dir = await this.store.directory(id);
        if ((await sourceManifest(dir, id)).fingerprint === state.fingerprint) {
          playbackUrl = pathToFileURL(await safePath(dir, 'derived/call.wav')).toString();
        }
      } catch { /* Never expose a persisted file URL or a path outside this call. */ }
    }
    return { state: state.state, progress: state.progress || 0, error: state.error || null,
      playbackUrl, transcript: state.transcript || null, warnings: state.warnings || [] };
  }
  async getPlaybackFile(id) {
    const dir = await this.store.directory(id);
    const derived = await validateDerived(dir, id, { playbackOnly: true, signal: this.abort.signal });
    return derived.playbackFile;
  }
  async getTranscript(id) {
    const state = await this.store.load(id);
    return state.transcript || { text: '', segments: [] };
  }
  schedule(id, delay = 0) {
    if (this.closed) return;
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    if (delay > 0) {
      const timer = setTimeout(() => { this.timers.delete(id); this.schedule(id); }, Math.min(delay, 2147483647));
      timer.unref?.(); this.timers.set(id, timer); return;
    }
    this.queue.add(id);
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null;
        if (this.queue.size && !this.closed) this.schedule(this.queue.values().next().value);
      });
    }
  }
  async drain() {
    while (this.queue.size && !this.closed) {
      const id = this.queue.values().next().value;
      this.queue.delete(id);
      await this.lock(id, async () => {
        let state;
        try {
          state = await this.store.load(id);
          await processCall(this, state);
        } catch (error) {
          if (!state || this.closed || error.code === 'cancelled') return;
          state.error = error instanceof CallError ? error.message : 'Call processing failed. Original audio is safe.';
          if (error.code === 'auth') { state.state = 'sign-in-required'; state.cloudHold = true; }
          else if (error.retry && state.retryCount < 8) {
            state.state = 'retrying'; state.retryCount += 1;
            state.nextAttemptAt = Date.now() + Math.min(300000, 2000 * 2 ** state.retryCount);
            this.schedule(id, state.nextAttemptAt - Date.now());
          } else state.state = 'failed';
          // Disk errors do not become an unhandled rejection or trigger upload without durable consent.
          await this.save(state).catch(() => { this.emit('change', { sessionId: id }); });
        }
      });
    }
  }
}
module.exports = { CallProcessing };
