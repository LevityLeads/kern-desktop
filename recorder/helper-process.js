'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomBytes } = require('crypto');
const { HelperTransport } = require('./helper-transport');
const { PROTOCOL_VERSION } = require('./protocol');

const CONNECT_TIMEOUT_MS = 7000;
const EXIT_WAIT_MS = 750;
const SHUTDOWN_TIMEOUT_MS = 1000;

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', onExit);
  });
}

// One running Kern.Recorder.Helper.exe and its pipe. Emits:
//   'message'            any frame from the helper (liveness)
//   'event' name payload a helper event (status)
//   'failure' error      the process exited or the pipe broke while it was expected to live
class HelperProcess extends EventEmitter {
  constructor({ child, transport }) {
    super();
    this.child = child;
    this.transport = transport;
    this.closed = false;
  }

  static async launch({ helperPath, buildLabel, spawnProcess = spawn,
    transportFactory = (options) => new HelperTransport(options), now = Date.now }) {
    const executable = path.resolve(helperPath);
    if (!fs.statSync(executable).isFile()) throw new Error('Bundled capture helper is missing');
    const pipeName = `kern-recorder-${randomBytes(16).toString('hex')}`;
    const child = spawnProcess(executable, [
      '--pipe', pipeName,
      '--parent-pid', String(process.pid),
      '--protocol', String(PROTOCOL_VERSION),
      '--app-build', buildLabel,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
      env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' },
    });
    const transport = transportFactory({ pipeName, now });
    const helper = new HelperProcess({ child, transport });
    helper._bind();
    try {
      await transport.connect(CONNECT_TIMEOUT_MS);
    } catch (error) {
      await helper.terminate();
      throw helper.spawnError || error;
    }
    return helper;
  }

  _bind() {
    let stderr = '';
    this.child.stderr?.setEncoding?.('utf8');
    this.child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
    });
    this.child.once('error', (error) => { this.spawnError = error; });
    this.child.once('exit', (code, signal) => {
      const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : '';
      this._failed(new Error(`Capture helper exited (${signal || code})${detail}`));
    });
    this.transport.on('message', () => this.emit('message'));
    this.transport.on('event', (event, payload) => this.emit('event', event, payload));
    this.transport.on('failure', (error) => this._failed(error));
  }

  _failed(error) {
    if (this.closed) return;
    this.closed = true;
    this.emit('failure', error);
  }

  request(command, payload, timeoutMs) {
    return this.transport.request(command, payload, timeoutMs);
  }

  hasCommandInFlight() {
    return this.transport.hasCommandInFlight();
  }

  // Graceful when possible, forced otherwise. Never throws.
  async shutdown() {
    this.closed = true;
    try { await this.transport.request('shutdown', {}, SHUTDOWN_TIMEOUT_MS); } catch { /* terminated below */ }
    await this.terminate();
  }

  async terminate() {
    this.closed = true;
    this.transport.close();
    const exited = await waitForExit(this.child, EXIT_WAIT_MS);
    if (!exited && this.child.exitCode === null) this.child.kill();
  }
}

module.exports = { HelperProcess, waitForExit };
