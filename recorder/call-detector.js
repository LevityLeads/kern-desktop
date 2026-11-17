'use strict';

const { EventEmitter } = require('events');

// Process names (lower-case, no .exe) of the apps whose microphone use counts as a call. Browsers
// are here because Meet, Teams on the web and Zoom on the web all hold the mic from the browser.
const CALL_APPS = Object.freeze(['ms-teams', 'msteams', 'teams', 'zoom', 'chrome', 'msedge']);
// Kern and its recorder helper hold the mic whenever Kern records. They must never start or sustain a call.
const OWN_APPS = Object.freeze(['kern', 'kern.recorder.helper']);
const START_HOLD_MS = 3000;
const END_SILENCE_MS = 90000;

// Turns mic-holder snapshots into call boundaries. A pure state machine: it reads the snapshot
// and the clock it is handed, never a timer of its own.
// Events: 'call-started' { app }, 'call-ended' { app }.
class CallDetector extends EventEmitter {
  constructor({ callApps = CALL_APPS, startHoldMs = START_HOLD_MS, endSilenceMs = END_SILENCE_MS } = {}) {
    super();
    this.callApps = new Set(callApps);
    this.startHoldMs = startHoldMs;
    this.endSilenceMs = endSilenceMs;
    this.reset();
  }

  reset() {
    this.heldSince = null;
    this.lastHeldAt = null;
    this.call = null;
  }

  get inCall() { return this.call !== null; }

  // apps: [{ pid, name }] currently holding the mic. nowMs: the clock for this snapshot.
  update(apps, nowMs) {
    const holder = this._holder(apps);
    if (this.call) {
      if (holder) { this.lastHeldAt = nowMs; return; }
      if (nowMs - this.lastHeldAt >= this.endSilenceMs) {
        const { app } = this.call;
        this.reset();
        this.emit('call-ended', { app });
      }
      return;
    }
    if (!holder) { this.heldSince = null; return; }
    this.heldSince ??= nowMs;
    if (nowMs - this.heldSince >= this.startHoldMs) {
      this.call = { app: holder };
      this.lastHeldAt = nowMs;
      this.emit('call-started', { app: holder });
    }
  }

  _holder(apps) {
    for (const app of Array.isArray(apps) ? apps : []) {
      const name = typeof app?.name === 'string' ? app.name.toLowerCase() : '';
      if (this.callApps.has(name) && !OWN_APPS.includes(name)) return name;
    }
    return null;
  }
}

module.exports = { CALL_APPS, END_SILENCE_MS, OWN_APPS, START_HOLD_MS, CallDetector };
