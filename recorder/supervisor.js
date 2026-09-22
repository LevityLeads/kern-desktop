'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const { HelperProcess } = require('./helper-process');
const { LIVE_STATES: LIVE, SILENT_LEVELS: SILENT, normalizeHelperStatus } = require('./helper-status');
const { COMMAND_TIMEOUTS: TIMEOUTS, Liveness, PING_INTERVAL_MS, PING_TIMEOUT_MS } = require('./liveness');
const { PowerSaveGuard } = require('./power-policy');
const power = require('./supervisor-power');
const { isActiveState } = require('./protocol');
const { readBuildInfo } = require('./build-info');
const catalog = require('./session-catalog');

function redactError(error) {
  return {
    code: typeof error?.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(error.code) ? error.code : 'capture-error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 500) : 'Capture failed',
  };
}

function idleStatus(build) {
  return { state: 'idle', sessionId: null, startedAtUtc: null, elapsedMs: 0, committedFrames: 0, micMuted: false,
    playbackMode: null, levels: SILENT, sources: [], failure: null, warning: null, pausedBy: null, pending: null, build };
}

// Owns the capture helper process and the one recording it may be running.
// Events: 'status' (every change), 'started' {sessionId, context}, 'ended' {sessionId, state, context, cutAtFrames}.
class RecorderSupervisor extends EventEmitter {
  constructor({ recordingsRoot, helperPath, platform = process.platform, launchHelper, powerSaveBlocker,
    now = () => Date.now(), buildInfo = readBuildInfo() }) {
    super();
    this.recordingsRoot = recordingsRoot;
    this.platform = platform;
    this.now = now;
    this.build = buildInfo.label;
    this.launchHelper = launchHelper || (() => HelperProcess.launch({ helperPath, buildLabel: buildInfo.label, now }));
    this.helper = null;
    this.heartbeat = null;
    this.pingInFlight = false;
    this.liveness = new Liveness({ now });
    this.suspendedAt = null;
    this.cutAtFrames = null;
    this.context = null;
    this.endedSessions = new Set();
    this.powerGuard = new PowerSaveGuard(powerSaveBlocker);
    this.status = idleStatus(this.build);
  }

  snapshot() { return structuredClone(this.status); }
  isActive() { return isActiveState(this.status.state); }

  // The capture of this call as it stands, or null when the helper is not capturing it. While
  // starting, committedFrames is 0. While asleep (or just woken), audio past the moment the
  // machine slept is held back: after a long sleep it is silence that will be trimmed off.
  liveCapture(sessionId) {
    const { state, committedFrames } = this.status;
    if (sessionId !== this.status.sessionId || !isActiveState(state)) return null;
    return { state, committedFrames: this.cutAtFrames === null ? committedFrames : Math.min(committedFrames, this.cutAtFrames) };
  }

  _set(patch) {
    this.status = { ...this.status, ...patch, build: this.build };
    this.emit('status', this.snapshot());
  }

  _requireWindows() {
    if (this.platform === 'win32') return;
    throw Object.assign(new Error('Call recording works only in the Windows app'), { code: 'windows-only' });
  }

  async _ensureHelper() {
    if (this.helper) return this.helper;
    this._requireWindows();
    const helper = await this.launchHelper();
    this.helper = helper;
    helper.on('message', () => this.liveness.activity());
    helper.on('event', (event, payload) => { if (event === 'status') this._applyHelperStatus(payload); });
    helper.on('failure', (error) => this._helperFailed(helper, error));
    this.liveness.reset();
    this.heartbeat = setInterval(() => this._tick(), PING_INTERVAL_MS);
    this.heartbeat.unref?.();
    return helper;
  }

  _tick() {
    const helper = this.helper;
    if (!helper) return;
    if (this.liveness.check({ commandInFlight: helper.hasCommandInFlight() }) === 'hung') {
      this._helperFailed(helper, Object.assign(new Error('The recorder stopped responding.'), { code: 'helper-hung' }));
      return;
    }
    if (this.pingInFlight) return;
    this.pingInFlight = true;
    // A slow ping is not a verdict; only the liveness clock decides.
    helper.request('ping', {}, PING_TIMEOUT_MS).catch(() => {}).finally(() => { this.pingInFlight = false; });
  }

  _applyHelperStatus(payload) {
    const next = normalizeHelperStatus(payload);
    if (!next || next.state === 'idle' || next.sessionId !== this.status.sessionId) return;
    const ended = next.state === 'stopped' || next.state === 'interrupted';
    let { pausedBy, state } = this.status;
    if (next.state === 'recording' && this.suspendedAt === null) pausedBy = null;
    if (next.state === 'paused' && !pausedBy) pausedBy = 'user';
    // A periodic status must not undo the "stopping" the user just asked for.
    state = state === 'stopping' && !ended ? 'stopping' : next.state;
    this._set({ ...next, state, pausedBy: ended ? null : pausedBy, levels: ended ? SILENT : next.levels });
    if (ended) this._sessionEnded(next.sessionId, next.state);
  }

  _sessionEnded(sessionId, state) {
    if (!sessionId || this.endedSessions.has(sessionId)) return;
    this.endedSessions.add(sessionId);
    this.powerGuard.release();
    const detail = { sessionId, state, context: this.context, cutAtFrames: this.cutAtFrames };
    this.context = null;
    this.cutAtFrames = null;
    this.emit('ended', detail);
    this._releaseHelper();
  }

  _helperFailed(helper, error) {
    if (helper !== this.helper) return;
    this._detach();
    helper.terminate();
    if (!isActiveState(this.status.state) || this.status.state === 'starting') return;
    this._set({ state: 'interrupted', failure: redactError(error), pending: null, levels: SILENT, pausedBy: null });
    this._sessionEnded(this.status.sessionId, 'interrupted');
  }

  _detach() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.helper = null;
    this.pingInFlight = false;
  }

  async _releaseHelper() {
    const helper = this.helper;
    if (!helper) return;
    this._detach();
    await helper.shutdown();
  }

  async listDevices() {
    const helper = await this._ensureHelper();
    try {
      return await helper.request('list-devices', {}, TIMEOUTS.control);
    } finally {
      if (!this.isActive() && this.helper === helper) await this._releaseHelper();
    }
  }

  async start({ microphone, context = null }) {
    if (this.isActive()) throw new Error('A recording is already running');
    this._requireWindows();
    const sessionId = catalog.createSessionId();
    const sessionPath = catalog.sessionDirectory(this.recordingsRoot, sessionId);
    fs.mkdirSync(this.recordingsRoot, { recursive: true, mode: 0o700 });
    this.context = context;
    this.cutAtFrames = null;
    this._set({ ...idleStatus(this.build), state: 'starting', sessionId, pending: 'start' });
    let sent = false;
    try {
      const helper = await this._ensureHelper();
      sent = true;
      this._applyHelperStatus(await helper.request('start', { sessionId, sessionPath, microphone }, TIMEOUTS.start));
      if (!LIVE.has(this.status.state)) throw new Error('The recorder did not start.');
      this._set({ pending: null });
      this.powerGuard.hold();
      this.emit('started', { sessionId, context });
      return this.snapshot();
    } catch (error) {
      const helper = this.helper;
      if (helper) { this._detach(); await helper.terminate(); }
      this._set({ ...idleStatus(this.build), failure: redactError(error) });
      // The helper may have created the session before failing; the pipeline decides what is there.
      if (sent) this._sessionEnded(sessionId, 'interrupted');
      this.context = null;
      throw error;
    }
  }

  _controlPayload(extra = {}) {
    return { ...extra, requestedAtUnixMs: this.now(), requestedAtMonotonicMs: performance.now() + 1 };
  }

  // A rejected or slow command is reported to the caller. It never ends the recording: only
  // the liveness clock or the helper itself can do that.
  async _control(command, extra) {
    const helper = this.helper;
    if (!helper || !LIVE.has(this.status.state)) throw new Error('No recording is running');
    this._set({ pending: command });
    try {
      this._applyHelperStatus(await helper.request(command, this._controlPayload(extra), TIMEOUTS.control));
      return this.snapshot();
    } finally {
      if (this.status.pending === command) this._set({ pending: null });
    }
  }

  pause() { return this._control('pause'); }
  resume() { return this._control('resume'); }
  setMicMuted(muted) { return this._control(muted ? 'mute-mic' : 'unmute-mic', { muted }); }

  async stop({ reason } = {}) {
    const helper = this.helper;
    if (!helper || !LIVE.has(this.status.state)) return this.snapshot();
    const { sessionId } = this.status;
    this._set({ state: 'stopping', pending: 'stop' });
    try {
      this._applyHelperStatus(await helper.request('stop', this._controlPayload(reason ? { reason } : {}), TIMEOUTS.stop));
    } catch (error) {
      // Unconfirmed stop: everything already in audio.pcm is intact, so end the session here.
      if (this.helper === helper) { this._detach(); await helper.terminate(); }
      this._set({ state: 'interrupted', failure: redactError(error), levels: SILENT, pausedBy: null });
      this._sessionEnded(sessionId, 'interrupted');
    } finally {
      this._set({ pending: null });
    }
    return this.snapshot();
  }

  // Sleep, wake and quit live in supervisor-power.js; these delegate so callers see one object.
  onSystemSuspend() { power.onSystemSuspend(this); }
  onSystemResume() { return power.onSystemResume(this); }
  shutdownForQuit(options) { return power.shutdownForQuit(this, options); }
}

module.exports = { RecorderSupervisor, TIMEOUTS, redactError };
