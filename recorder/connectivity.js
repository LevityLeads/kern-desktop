'use strict';

const { EventEmitter } = require('node:events');

// The main process has no 'online' event, so poll Electron's net.isOnline() and emit 'online'
// on every offline -> online transition.
class Connectivity extends EventEmitter {
  constructor({ isOnline, intervalMs = 5000 }) {
    super();
    this.isOnline = isOnline;
    this.intervalMs = intervalMs;
    this.online = null;
    this.timer = null;
  }

  check() {
    let online;
    try { online = this.isOnline() !== false; } catch { online = true; }
    if (online && this.online === false) this.emit('online');
    this.online = online;
  }

  start() {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Connectivity };
