'use strict';

const { CallDetector } = require('./call-detector');

const TICK_MS = 1000;
const DISPLAY_NAMES = Object.freeze({ 'ms-teams': 'Teams', msteams: 'Teams', teams: 'Teams', zoom: 'Zoom', chrome: 'Chrome', msedge: 'Edge' });

function displayName(app) {
  return DISPLAY_NAMES[String(app).toLowerCase()] || String(app);
}

// Glue between the mic watcher, the call detector and the recorder. When a call app takes the
// mic it asks (a notification, never an automatic start) whether to record. A click starts through
// the same path as the recorder window's Start button, so every consent and settings check
// applies. A recording started from the prompt is stopped when the call ends; a manual one never is.
function createCallPrompt({ watcher, settings, supervisor, start, showRecorder, Notification,
  detector = new CallDetector(), now = Date.now, setTicker = setInterval, clearTicker = clearInterval, log = console }) {
  let apps = [];
  let ticker = null;
  let pending = null;          // the "Record this call?" notification awaiting a click
  let promptSessionId = null;  // the recording this prompt started, the only one it may stop

  const notify = (options, onClick) => {
    try {
      if (!Notification.isSupported()) return null;
      const notification = new Notification(options);
      if (onClick) notification.on('click', onClick);
      notification.show();
      return notification;
    } catch (error) {
      log.error('Call prompt notification failed:', error?.message || error);
      return null;
    }
  };

  const tick = () => detector.update(apps, now());

  async function onClick(notification) {
    if (pending !== notification) return; // second click, or the call already ended
    pending = null;
    // The one-time recording notice lives in the recorder window; never start before it is seen.
    if (!settings.get().noticeAcknowledged) { showRecorder(); return; }
    if (supervisor.isActive()) return;
    try {
      const status = await start();
      promptSessionId = status?.sessionId || null;
    } catch (error) {
      log.error('Call prompt could not start recording:', error?.message || error);
      showRecorder();
    }
  }

  detector.on('call-started', ({ app }) => {
    if (!settings.get().callPrompt || supervisor.isActive() || pending) return;
    const notification = notify(
      { title: 'Record this call?', body: `${displayName(app)} is using your microphone. Click to record.` },
      () => onClick(notification),
    );
    pending = notification;
  });

  detector.on('call-ended', async () => {
    if (pending) { try { pending.close?.(); } catch { /* already closed */ } pending = null; }
    const sessionId = promptSessionId;
    promptSessionId = null;
    if (!sessionId || !supervisor.isActive() || supervisor.snapshot().sessionId !== sessionId) return;
    try {
      await supervisor.stop();
      notify({ title: 'Call ended. Recording stopped.' }, () => showRecorder());
    } catch (error) { log.error('Call prompt could not stop recording:', error?.message || error); }
  });

  // A prompt-started recording that ends any other way (manual Stop, crash) is no longer ours.
  const onEnded = ({ sessionId }) => { if (sessionId === promptSessionId) promptSessionId = null; };
  const onApps = (next) => { apps = next; tick(); };

  return {
    start() {
      watcher.on('apps', onApps);
      supervisor.on('ended', onEnded);
      ticker = setTicker(tick, TICK_MS);
      ticker.unref?.();
      watcher.start();
    },
    stop() {
      watcher.stop();
      watcher.off('apps', onApps);
      supervisor.off('ended', onEnded);
      clearTicker(ticker);
      ticker = null;
      pending = null;
    },
    detector,
  };
}

module.exports = { DISPLAY_NAMES, createCallPrompt, displayName };
