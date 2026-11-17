'use strict';

// Pure transition policy for recording problems. Only a recording that has actually stopped
// brings the recorder window forward; a warning the helper is already fixing ("Microphone
// disconnected. Reconnecting.") becomes a quiet notification, and only if it lasts.
const WARNING_NOTIFY_AFTER_MS = 10000;

class CaptureHealthAlerts {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.sessionId = null;
    this.wasActive = false;
    this.warning = null;
    this.warningSince = 0;
    this.notified = new Set();
  }

  update(status) {
    if (!status?.sessionId) return null;
    if (status.sessionId !== this.sessionId) {
      this.sessionId = status.sessionId;
      this.wasActive = false;
      this.warning = null;
      this.notified.clear();
    }
    if (status.state === 'recording' || status.state === 'paused') this.wasActive = true;
    if (status.state === 'interrupted' && this.wasActive && status.failure) {
      this.wasActive = false;
      return {
        title: 'Recording stopped',
        body: `${status.failure.message} Everything up to that point is saved and will be transcribed.`,
        focus: true,
      };
    }
    if (status.state !== 'recording' || !status.warning) { this.warning = null; return null; }
    if (status.warning !== this.warning) { this.warning = status.warning; this.warningSince = this.now(); return null; }
    if (this.now() - this.warningSince < WARNING_NOTIFY_AFTER_MS || this.notified.has(status.warning)) return null;
    this.notified.add(status.warning);
    return { title: 'Recording needs a look', body: status.warning, focus: false };
  }
}

function presentCaptureAlert(alert, { showRecorder, Notification, reportError }) {
  if (!alert) return;
  // UI and OS errors must never escape a status listener.
  if (alert.focus) {
    try { showRecorder(); } catch (error) { reportError(error); }
  }
  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: alert.title, body: alert.body });
    notification.on('click', () => { try { showRecorder(); } catch (error) { reportError(error); } });
    notification.show();
  } catch (error) { reportError(error); }
}

module.exports = { CaptureHealthAlerts, WARNING_NOTIFY_AFTER_MS, presentCaptureAlert };
