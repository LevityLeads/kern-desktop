'use strict';

// Decides when the capture helper is hung. Pure policy: the supervisor feeds it activity (any
// message from the helper, including the 500 ms status events and ping replies) and asks it on
// every heartbeat tick.
const PING_INTERVAL_MS = 2000;
const PING_TIMEOUT_MS = 5000;
// Each command's own reply budget. start covers process loopback activation (up to ~6 s).
const COMMAND_TIMEOUTS = Object.freeze({ start: 20000, stop: 15000, control: 5000 });
const HUNG_AFTER_MS = 15000;
// A tick arriving this long after the previous one means our own process was frozen (system
// sleep, a debugger, a starved event loop). Silence from the helper during that time is not
// evidence of anything, so the clock restarts instead of killing a healthy recording.
const FROZEN_GAP_MS = PING_INTERVAL_MS * 3;

class Liveness {
  constructor({ now = Date.now, hungAfterMs = HUNG_AFTER_MS, frozenGapMs = FROZEN_GAP_MS } = {}) {
    this.now = now;
    this.hungAfterMs = hungAfterMs;
    this.frozenGapMs = frozenGapMs;
    this.suspended = false;
    this.reset();
  }

  reset() {
    const now = this.now();
    this.lastActivityAt = now;
    this.lastTickAt = now;
  }

  activity() {
    this.lastActivityAt = this.now();
  }

  // 'ok' or 'hung'. Never 'hung' while the system is suspended or while a command is still
  // inside its own timeout: the helper answers pings during slow commands, so a command that
  // outlives its budget will time out on its own and the silence will be judged after that.
  check({ commandInFlight = false } = {}) {
    const now = this.now();
    const sinceTick = now - this.lastTickAt;
    this.lastTickAt = now;
    if (sinceTick > this.frozenGapMs) {
      this.lastActivityAt = now;
      return 'ok';
    }
    if (this.suspended || commandInFlight) return 'ok';
    return now - this.lastActivityAt > this.hungAfterMs ? 'hung' : 'ok';
  }
}

module.exports = { COMMAND_TIMEOUTS, FROZEN_GAP_MS, HUNG_AFTER_MS, Liveness, PING_INTERVAL_MS, PING_TIMEOUT_MS };
