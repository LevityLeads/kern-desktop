'use strict';

const { CallDetector } = require('./call-detector');

const TICK_MS = 1000;
const DISPLAY_NAMES = Object.freeze({
  'ms-teams': 'Teams', 'ms-teams_modulehost': 'Teams', msteams: 'Teams', teams: 'Teams', zoom: 'Zoom', chrome: 'Chrome', msedge: 'Edge',
});

function displayName(app) {
  return DISPLAY_NAMES[String(app).toLowerCase()] || String(app);
}

// Glue between the mic watcher, the call detector and the recorder. When a call app takes the
// mic it asks whether to record, on a card that floats above the call (prompt-card.js), never an
// automatic start. Record starts through the same path as the recorder window's Start button, so
// every consent and settings check applies. The card stays until it is answered, the call ends or
// a recording starts some other way; "Not now" holds for the rest of that call. Record uses the
// microphone the call app is using (the helper reports each holder's endpoint), so the recording
// hears what the call hears; the saved choice applies only when that is ambiguous or unknown.
// A recording started from the card is stopped when the call ends; a manual one never is.
function createCallPrompt({ watcher, card, settings, supervisor, start, showRecorder, Notification,
  detector = new CallDetector(), now = Date.now, setTicker = setInterval, clearTicker = clearInterval, log = console }) {
  let apps = [];
  let ticker = null;
  let pending = null;          // the open card: { app, handle }, or null
  let promptSessionId = null;  // the recording this prompt started, the only one it may stop
  let last = null;             // the latest prompt decision, for diagnostics

  const at = () => new Date(now()).toISOString();
  const noteLast = (app, outcome) => { last = { at: at(), app, outcome }; };
  const decide = (outcome) => { last = { ...last, outcome, decidedAt: at() }; };

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

  const withdraw = (outcome) => {
    if (!pending) return;
    const { handle } = pending;
    pending = null;
    handle?.close();
    decide(outcome);
  };

  // The one microphone the call app holds right now, or null when it holds none or several.
  const callMicrophone = (app) => {
    const endpoints = new Set(apps.filter((holder) => holder.name === app && holder.endpoint).map((holder) => holder.endpoint));
    return endpoints.size === 1 ? { mode: 'device', deviceId: [...endpoints][0] } : null;
  };

  async function onRecord(token) {
    if (pending !== token) return; // already answered, or the call already ended
    pending = null;
    const microphone = callMicrophone(token.app);
    decide('record');
    last = { ...last, microphone: microphone ? microphone.deviceId : 'saved choice' };
    // The one-time recording notice lives in the recorder window; never start before it is seen.
    if (!settings.get().noticeAcknowledged) { showRecorder(); return; }
    if (supervisor.isActive()) return;
    try {
      let status;
      try { status = await start(microphone ? { microphone } : {}); }
      catch (error) {
        if (!microphone) throw error;
        // The call's microphone would not open (unplugged in between, exclusive use): the saved choice still records.
        log.error('Call prompt could not open the call microphone:', error?.message || error);
        last = { ...last, microphone: `saved choice (call microphone failed: ${String(error?.message || error).slice(0, 80)})` };
        status = await start({});
      }
      promptSessionId = status?.sessionId || null;
    } catch (error) {
      log.error('Call prompt could not start recording:', error?.message || error);
      decide(`record failed: ${String(error?.message || error).slice(0, 120)}`);
      showRecorder();
    }
  }

  function onDismiss(token) {
    if (pending !== token) return;
    pending = null;
    decide('not now');
  }

  detector.on('call-started', ({ app }) => {
    if (!settings.get().callPrompt) { noteLast(app, 'skipped: prompt turned off'); return; }
    if (supervisor.isActive()) { noteLast(app, 'skipped: already recording'); return; }
    if (pending) return;
    const token = { app, handle: null };
    pending = token;
    noteLast(app, 'shown');
    try {
      token.handle = card.show({
        title: 'Record this call?', body: `${displayName(app)} is using your microphone.`, primary: 'Record',
        onPrimary: () => onRecord(token), onDismiss: () => onDismiss(token),
      });
    } catch (error) {
      pending = null;
      log.error('Call prompt card failed:', error?.message || error);
      decide(`card failed: ${String(error?.message || error).slice(0, 120)}`);
    }
  });

  detector.on('call-ended', async () => {
    withdraw('withdrawn: call ended');
    const sessionId = promptSessionId;
    promptSessionId = null;
    if (!sessionId || !supervisor.isActive() || supervisor.snapshot().sessionId !== sessionId) return;
    try {
      await supervisor.stop();
      notify({ title: 'Call ended. Recording stopped.' }, () => showRecorder());
    } catch (error) { log.error('Call prompt could not stop recording:', error?.message || error); }
  });

  // A recording started any other way (the window's Start, the tray) answers the card.
  const onStarted = () => withdraw('withdrawn: recording started elsewhere');
  // A prompt-started recording that ends any other way (manual Stop, crash) is no longer ours.
  const onEnded = ({ sessionId }) => { if (sessionId === promptSessionId) promptSessionId = null; };
  const onApps = (next) => { apps = next; tick(); };

  return {
    start() {
      watcher.on('apps', onApps);
      supervisor.on('started', onStarted);
      supervisor.on('ended', onEnded);
      ticker = setTicker(tick, TICK_MS);
      ticker.unref?.();
      watcher.start();
    },
    stop() {
      watcher.stop();
      watcher.off('apps', onApps);
      supervisor.off('started', onStarted);
      supervisor.off('ended', onEnded);
      clearTicker(ticker);
      ticker = null;
      pending?.handle?.close();
      pending = null;
    },
    // What the prompt saw and decided, for "Copy diagnostics". Process names only, never audio or titles.
    diagnostics() {
      const call = detector.status();
      const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
      return {
        enabled: settings.get().callPrompt !== false,
        micHolders: apps.map((app) => (app.endpoint ? `${app.name} @ ${app.endpoint}` : app.name)),
        watcher: watcher.status?.() ?? null,
        detector: { ...call, heldSince: iso(call.heldSince), lastHeldAt: iso(call.lastHeldAt) },
        cardOpen: pending !== null,
        last,
      };
    },
    detector,
  };
}

module.exports = { DISPLAY_NAMES, createCallPrompt, displayName };
