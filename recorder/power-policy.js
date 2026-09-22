'use strict';

// What to do with a recording when the machine wakes up. A short sleep (lid closed on the way
// to another room) resumes the call; a long one means the call is over, so it is stopped and
// processed like any other finished call.
const AUTO_RESUME_LIMIT_MS = 10 * 60 * 1000;

// pausedBy: who paused the helper session ('user' | 'suspend' | null).
function wakeAction({ pausedBy, sleptMs, hasSession }) {
  if (!hasSession || pausedBy !== 'suspend') return 'none';
  if (!Number.isFinite(sleptMs) || sleptMs < 0) return 'resume';
  return sleptMs < AUTO_RESUME_LIMIT_MS ? 'resume' : 'stop';
}

// Keeps Windows from suspending the app while a call records. Electron's powerSaveBlocker is
// optional so tests and non-Electron callers can pass nothing.
class PowerSaveGuard {
  constructor(blocker) { this.blocker = blocker; this.id = null; }

  hold() {
    if (!this.blocker || this.id !== null) return;
    this.id = this.blocker.start('prevent-app-suspension');
  }

  release() {
    if (!this.blocker || this.id === null) return;
    if (this.blocker.isStarted(this.id)) this.blocker.stop(this.id);
    this.id = null;
  }
}

module.exports = { AUTO_RESUME_LIMIT_MS, PowerSaveGuard, wakeAction };
