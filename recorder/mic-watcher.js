'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_APPS = 64;
const MAX_NAME_LENGTH = 100;

// The code of a helper `{"type":"error","code":...}` line, or null when the line is not one.
function parseErrorLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return null; }
  if (!message || typeof message !== 'object' || message.type !== 'error' || typeof message.code !== 'string') return null;
  return message.code.slice(0, MAX_NAME_LENGTH);
}

// One stdout line from `Kern.Recorder.Helper.exe --mic-watch`, or null when it is not a mic snapshot.
function parseMicLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return null; }
  if (!message || typeof message !== 'object' || message.type !== 'mic' || !Array.isArray(message.apps)) return null;
  const apps = [];
  for (const app of message.apps.slice(0, MAX_APPS)) {
    if (Number.isInteger(app?.pid) && app.pid > 0 && typeof app.name === 'string' && app.name.length > 0 && app.name.length <= MAX_NAME_LENGTH) {
      apps.push({ pid: app.pid, name: app.name.toLowerCase() });
    }
  }
  return apps;
}

// Keeps a `--mic-watch` helper running and reports who holds the microphone.
// Events: 'apps' [{ pid, name }] on every snapshot, and [] whenever the helper is not running
// (an unknown mic is treated as nobody holding it, so a dead watcher never keeps a call alive).
class MicWatcher extends EventEmitter {
  constructor({ helperPath, platform = process.platform, parentPid = process.pid, spawnProcess = spawn,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, log = console }) {
    super();
    Object.assign(this, { helperPath, platform, parentPid, spawnProcess, setTimer, clearTimer, now, log });
    this.child = null;
    this.timer = null;
    this.stopped = true;
    this.backoffMs = BACKOFF_START_MS;
    this.health = { launches: 0, lastSnapshotAt: null, lastStop: null, lastHelperError: null };
  }

  // For diagnostics: whether the helper runs, when it last reported, and why it last stopped.
  status() {
    return { platform: this.platform, running: this.child !== null, restartPending: this.timer !== null, ...this.health };
  }

  stamp() { return new Date(this.now()).toISOString(); }

  start() {
    if (this.platform !== 'win32' || !this.stopped) return;
    this.stopped = false;
    this._launch();
  }

  stop() {
    this.stopped = true;
    this.clearTimer(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    if (child) { try { child.kill(); } catch { /* already gone */ } }
  }

  _launch() {
    this.timer = null;
    let child;
    try {
      child = this.spawnProcess(this.helperPath, ['--mic-watch', '--parent-pid', String(this.parentPid)], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false,
        env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' },
      });
    } catch (error) {
      this.log.error('Mic watcher could not start:', error?.message || error);
      this.health.lastStop = { at: this.stamp(), why: `spawn failed: ${String(error?.message || error).slice(0, 200)}` };
      this._scheduleRestart();
      return;
    }
    this.child = child;
    this.health.launches += 1;
    let buffered = '';
    let ended = false;
    const onEnd = (why) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      this.log.error('Mic watcher stopped:', why);
      this.health.lastStop = { at: this.stamp(), why: String(why).slice(0, 200) };
      this.emit('apps', []);
      this._scheduleRestart();
    };
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      buffered += String(chunk);
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        const apps = line ? parseMicLine(line) : null;
        if (apps) {
          this.backoffMs = BACKOFF_START_MS;
          this.health.lastSnapshotAt = this.stamp();
          if (!this.stopped) this.emit('apps', apps);
          continue;
        }
        const code = line ? parseErrorLine(line) : null;
        if (code) this.health.lastHelperError = { at: this.stamp(), code };
      }
      if (buffered.length > MAX_LINE_BYTES) buffered = '';
    });
    child.once('error', (error) => onEnd(error?.message || 'error'));
    child.once('exit', (code, signal) => onEnd(`exit ${signal || code}`));
  }

  _scheduleRestart() {
    if (this.stopped || this.timer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.timer = this.setTimer(() => this._launch(), delay);
    this.timer.unref?.();
  }
}

module.exports = { BACKOFF_MAX_MS, BACKOFF_START_MS, MicWatcher, parseErrorLine, parseMicLine };
