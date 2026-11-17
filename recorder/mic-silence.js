'use strict';

const SILENT_MS = 20000;

// Spots a recording whose microphone has sent nothing but digital silence since it started. A
// working microphone always carries some room noise, so a level of exactly 0 means the recording
// cannot hear the user: a muted device, a privacy block, or the wrong microphone. Measured
// 17 Nov 2026: two test calls where the chosen webcam microphone sent only zeros and the user's
// side of the call was lost without a word of warning.
// Once the microphone has carried any sound in a recording it is trusted for the rest of it, so a
// noise-suppressing virtual microphone that sends zeros while the user listens never alarms.
class MicSilenceMonitor {
  constructor({ silentMs = SILENT_MS } = {}) {
    this.silentMs = silentMs;
    this.reset(null);
  }

  reset(sessionId) {
    this.sessionId = sessionId;
    this.silentSince = null;
    this.heard = false;
    this.alerted = false;
  }

  // status: a supervisor status. Returns { sessionId, name } once per recording when its microphone
  // has been silent for silentMs of live recording; null otherwise.
  update(status, nowMs) {
    if (!status?.sessionId) { this.reset(null); return null; }
    if (status.sessionId !== this.sessionId) this.reset(status.sessionId);
    if (this.heard || this.alerted) return null;
    const mic = (Array.isArray(status.sources) ? status.sources : []).find((source) => source?.lane === 'me');
    const live = status.state === 'recording' && status.micMuted !== true && mic?.state === 'active';
    if (!live) { this.silentSince = null; return null; }
    if (mic.level > 0) { this.heard = true; return null; }
    this.silentSince ??= nowMs;
    if (nowMs - this.silentSince < this.silentMs) return null;
    this.alerted = true;
    return { sessionId: status.sessionId, name: typeof mic.name === 'string' && mic.name ? mic.name.slice(0, 48) : 'Your microphone' };
  }
}

module.exports = { MicSilenceMonitor, SILENT_MS };
