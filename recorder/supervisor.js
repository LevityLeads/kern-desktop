'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomBytes } = require('crypto');
const { HelperTransport } = require('./helper-transport');
const { PROTOCOL_VERSION, isActiveState } = require('./protocol');
const catalog = require('./session-catalog');

const HELPER_CONNECT_TIMEOUT_MS = 7000;
const HELPER_COMMAND_TIMEOUT_MS = 1000;
const HELPER_STOP_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 1000;
const HEARTBEAT_GRACE_MS = 3500;

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function redactError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'capture-error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 500) : 'Capture failed',
  };
}

class RecorderSupervisor extends EventEmitter {
  constructor({
    recordingsRoot,
    helperPath,
    platform = process.platform,
    spawnProcess = spawn,
    transportFactory = (options) => new HelperTransport(options),
    powerSaveBlocker,
    now = () => Date.now(),
  }) {
    super();
    this.recordingsRoot = recordingsRoot;
    this.helperPath = helperPath;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.transportFactory = transportFactory;
    this.powerSaveBlocker = powerSaveBlocker;
    this.now = now;
    this.child = null;
    this.transport = null;
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
    this.powerSaveBlockerId = null;
    this.lastHeartbeatAt = 0;
    this.status = {
      protocolVersion: PROTOCOL_VERSION,
      state: 'idle',
      sessionId: null,
      micMuted: false,
      startedAtUtc: null,
      effectiveElapsedMs: 0,
      freeBytes: null,
      tracks: [],
      failure: null,
      pendingCommand: null,
    };
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.status));
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.snapshot());
  }

  _requireWindows() {
    if (this.platform !== 'win32') {
      const error = new Error('Computer audio capture is available only in the packaged Windows app');
      error.code = 'windows-only';
      throw error;
    }
  }

  _requireTransport() {
    if (!this.transport) throw new Error('Capture helper is not running');
    return this.transport;
  }

  _startPowerBlocker() {
    if (!this.powerSaveBlocker || this.powerSaveBlockerId !== null) return;
    this.powerSaveBlockerId = this.powerSaveBlocker.start('prevent-app-suspension');
  }

  _stopPowerBlocker() {
    if (!this.powerSaveBlocker || this.powerSaveBlockerId === null) return;
    if (this.powerSaveBlocker.isStarted(this.powerSaveBlockerId)) {
      this.powerSaveBlocker.stop(this.powerSaveBlockerId);
    }
    this.powerSaveBlockerId = null;
  }

  _resolveHelperPath() {
    const helperPath = path.resolve(this.helperPath);
    if (!fs.statSync(helperPath).isFile()) throw new Error('Bundled capture helper is missing');
    return helperPath;
  }

  async _launch(sessionId) {
    this._requireWindows();
    if (this.child || this.transport) throw new Error('Capture helper is already running');

    fs.mkdirSync(this.recordingsRoot, { recursive: true, mode: 0o700 });
    const pipeName = `kern-recorder-${randomBytes(16).toString('hex')}`;
    const helperPath = this._resolveHelperPath();
    const child = this.spawnProcess(helperPath, [
      '--pipe', pipeName,
      '--parent-pid', String(process.pid),
      '--protocol', String(PROTOCOL_VERSION),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
      env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' },
    });
    this.child = child;

    let stderr = '';
    let spawnError = null;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
      this._handleHelperFailure(new Error(`Capture helper exited (${signal || code})${detail}`));
    });

    const transport = this.transportFactory({ pipeName, requestTimeoutMs: HELPER_COMMAND_TIMEOUT_MS });
    this.transport = transport;
    transport.on('event', (event, payload) => this._handleHelperEvent(event, payload));
    transport.on('failure', (error) => this._handleHelperFailure(error));

    try {
      await transport.connect(HELPER_CONNECT_TIMEOUT_MS);
    } catch (error) {
      await this._terminateHelper();
      throw spawnError || error;
    }

    this.lastHeartbeatAt = this.now();
    this.heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    return { sessionId };
  }

  async listDevices() {
    this._requireWindows();
    if (this.transport) return this.transport.request('list-devices');

    await this._launch(null);
    try {
      return await this._requireTransport().request('list-devices', {}, 3000);
    } finally {
      await this._shutdownIdleHelper();
    }
  }

  listSessions() {
    return catalog.listSessions(this.recordingsRoot);
  }

  getSession(sessionId) {
    return catalog.readManifest(this.recordingsRoot, sessionId);
  }

  async start(payload) {
    if (this.status.state !== 'idle' && this.status.state !== 'stopped' && this.status.state !== 'interrupted') {
      throw new Error('A recording session is already active');
    }

    const sessionId = catalog.createSessionId();
    const sessionPath = catalog.sessionDirectory(this.recordingsRoot, sessionId);
    this._setStatus({
      state: 'starting',
      sessionId,
      micMuted: false,
      startedAtUtc: new Date().toISOString(),
      tracks: [],
      failure: null,
      pendingCommand: 'start',
    });

    try {
      await this._launch(sessionId);
      const result = await this._requireTransport().request('start', {
        sessionId,
        sessionPath,
        microphone: payload.microphone,
        segmentDurationMs: 5000,
      }, 5000);
      this._startPowerBlocker();
      this._setStatus({ ...result, state: result.state || 'recording', pendingCommand: null });
      return this.snapshot();
    } catch (error) {
      await this._terminateHelper();
      this._setStatus({ state: 'interrupted', failure: redactError(error), pendingCommand: null });
      throw error;
    }
  }

  _controlPayload(payload = {}) {
    return {
      ...payload,
      requestedAtUnixMs: this.now(),
      requestedAtMonotonicMs: Number(process.hrtime.bigint()) / 1_000_000,
    };
  }

  async _acknowledgedCommand(command, pendingState, successState, payload = {}) {
    const transport = this._requireTransport();
    if (!isActiveState(this.status.state)) throw new Error('No active recording session');
    this._setStatus({ state: pendingState, pendingCommand: command });
    try {
      const result = await transport.request(
        command,
        this._controlPayload(payload),
        HELPER_COMMAND_TIMEOUT_MS
      );
      this._setStatus({ ...result, state: result.state || successState, pendingCommand: null });
      return this.snapshot();
    } catch (error) {
      await this._interruptForUnacknowledgedCommand(command, error);
      throw error;
    }
  }

  pause() {
    return this._acknowledgedCommand('pause', 'pausing', 'paused');
  }

  resume() {
    return this._acknowledgedCommand('resume', 'resuming', 'recording');
  }

  setMicMuted(muted) {
    return this._acknowledgedCommand(
      muted ? 'mute-mic' : 'unmute-mic',
      muted ? 'muting' : 'unmuting',
      this.status.state === 'paused' ? 'paused' : 'recording',
      { muted }
    );
  }

  async stop() {
    if (!this.transport) return this.snapshot();
    this._setStatus({ state: 'stopping', pendingCommand: 'stop' });
    try {
      const result = await this.transport.request('stop', this._controlPayload(), HELPER_STOP_TIMEOUT_MS);
      this._setStatus({ ...result, state: result.state || 'stopped', pendingCommand: null });
      await this._shutdownIdleHelper();
      return this.snapshot();
    } catch (error) {
      await this._interruptForUnacknowledgedCommand('stop', error);
      throw error;
    } finally {
      this._stopPowerBlocker();
    }
  }

  async suspend() {
    if (!this.transport || !isActiveState(this.status.state)) return;
    try {
      const result = await this.transport.request('suspend', this._controlPayload(), HELPER_COMMAND_TIMEOUT_MS);
      this._setStatus({ ...result, state: 'suspended', pendingCommand: null });
    } catch (error) {
      await this._interruptForUnacknowledgedCommand('suspend', error);
    }
  }

  async recover(sessionId) {
    if (this.transport) throw new Error('Stop the active recording before recovery');
    const manifest = catalog.readManifest(this.recordingsRoot, sessionId);
    if (manifest.state === 'stopped' || manifest.state === 'interrupted') return manifest;

    await this._launch(sessionId);
    try {
      const manifest = await this.transport.request('recover', {
        sessionId,
        sessionPath: catalog.sessionDirectory(this.recordingsRoot, sessionId),
      }, HELPER_STOP_TIMEOUT_MS);
      return manifest;
    } finally {
      await this._shutdownIdleHelper();
    }
  }

  async shutdownForQuit() {
    if (this.transport && isActiveState(this.status.state)) {
      try {
        await this.transport.request(
          'stop',
          this._controlPayload({ reason: 'application-quit' }),
          HELPER_STOP_TIMEOUT_MS
        );
      } catch {
        // Parent-watchdog and process termination remain the final fence.
      }
    }
    await this._terminateHelper();
    this._stopPowerBlocker();
  }

  async _interruptForUnacknowledgedCommand(command, error) {
    await this._terminateHelper();
    this._stopPowerBlocker();
    this._setStatus({
      state: 'interrupted',
      pendingCommand: null,
      failure: {
        code: 'unacknowledged-command',
        message: `Capture helper did not acknowledge ${command}: ${error.message}`,
      },
    });
  }

  _handleHelperEvent(event, payload) {
    if (event === 'status') {
      this._setStatus(payload || {});
    } else if (event === 'heartbeat') {
      this.lastHeartbeatAt = this.now();
    } else if (event === 'failure') {
      this._handleHelperFailure(Object.assign(new Error(payload?.message || 'Capture helper failed'), {
        code: payload?.code,
      }));
    }
  }

  async _heartbeat() {
    if (!this.transport || this.heartbeatInFlight) return;
    if (this.now() - this.lastHeartbeatAt > HEARTBEAT_GRACE_MS) {
      await this._handleHelperFailure(new Error('Capture helper heartbeat stopped'));
      return;
    }
    this.heartbeatInFlight = true;
    try {
      await this.transport.request('ping', {}, 900);
      this.lastHeartbeatAt = this.now();
    } catch (error) {
      await this._handleHelperFailure(error);
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  async _handleHelperFailure(error) {
    if (!this.child && !this.transport) return;
    const wasActive = isActiveState(this.status.state);
    await this._terminateHelper();
    this._stopPowerBlocker();
    if (wasActive) {
      this._setStatus({ state: 'interrupted', pendingCommand: null, failure: redactError(error) });
    }
  }

  async _shutdownIdleHelper() {
    if (this.transport) {
      try {
        await this.transport.request('shutdown', {}, 1000);
      } catch {
        // The process is terminated below if graceful shutdown fails.
      }
    }
    await this._terminateHelper();
  }

  async _terminateHelper(force = true) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const transport = this.transport;
    const child = this.child;
    this.transport = null;
    this.child = null;
    transport?.close();
    if (!child) return;
    const exited = await waitForExit(child, 750);
    if (!exited && force && child.exitCode === null) child.kill();
  }
}

module.exports = {
  HELPER_COMMAND_TIMEOUT_MS,
  HEARTBEAT_GRACE_MS,
  RecorderSupervisor,
  redactError,
  waitForExit,
};
