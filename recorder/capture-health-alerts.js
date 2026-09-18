'use strict';

// Pure transition policy; Electron owns displaying the returned alert.
class CaptureHealthAlerts {
  constructor() { this.sessionId = null; this.problem = ''; this.failedKinds = new Set(); }

  update(status) {
    if (!status?.sessionId) return null;
    if (status.sessionId !== this.sessionId) {
      this.sessionId = status.sessionId;
      this.problem = '';
      this.failedKinds.clear();
    }
    if (status.state === 'interrupted' && status.failure) {
      if (this.problem === 'interrupted') return null;
      this.problem = 'interrupted';
      return { title: 'Recording interrupted', body: 'Audio capture stopped unexpectedly. Open the recorder before continuing your call.' };
    }
    if (!['recording', 'degraded'].includes(status.state)) return null;
    const tracks = (status.tracks || []).filter(track => !track.retired && track.active !== false);
    const unavailable = kind => {
      const selected = tracks.filter(track => track.kind === kind);
      return !selected.length || selected.every(track =>
        ['failed', 'stalled', 'recovering', 'unknown'].includes(track.health));
    };
    const failed = ['render', 'microphone'].filter(kind =>
      !(kind === 'microphone' && status.micMuted) && unavailable(kind));
    const failureCode = status.failure?.code;
    const mutedMicFailure = status.micMuted && this.failedKinds.has('microphone') &&
      !failed.length && ['track-failed', 'endpoint-add-failed'].includes(failureCode);
    if (mutedMicFailure) return null;
    const problem = failed.join(',') || (status.failure ? 'capture' : '');
    if (problem) {
      for (const kind of failed) this.failedKinds.add(kind);
      if (problem === this.problem) return null;
      this.problem = problem;
      const sides = failed.map(kind => kind === 'render' ? 'Incoming audio' : 'Your microphone');
      return { title: 'Recording needs attention', body: sides.length
        ? `${sides.join(' and ')} unavailable. Some of this conversation may be missing.`
        : 'Recording reported a failure. Open the recorder to check what is still being captured.' };
    }
    if (!this.problem || status.state !== 'recording') return null;
    // Muting a failed mic is not evidence that it recovered.
    if (this.failedKinds.has('microphone') && status.micMuted) return null;
    this.problem = '';
    this.failedKinds.clear();
    return { title: 'Recording recovered', body: 'Audio capture has resumed. Earlier audio may still be missing.' };
  }
}

function presentCaptureAlert(alert, { showRecorder, Notification, reportError }) {
  if (!alert) return;
  // UI/OS errors must never escape a capture status listener.
  if (alert.title !== 'Recording recovered') {
    try { showRecorder(); } catch (error) { reportError(error); }
  }
  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification(alert);
    notification.on('click', () => {
      try { showRecorder(); } catch (error) { reportError(error); }
    });
    notification.show();
  } catch (error) { reportError(error); }
}

module.exports = { CaptureHealthAlerts, presentCaptureAlert };
