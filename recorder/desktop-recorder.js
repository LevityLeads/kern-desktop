'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { RecorderSupervisor } = require('./supervisor');
const { CallHttp } = require('./call-http');
const { CallPipeline } = require('./call-pipeline');
const { CallService } = require('./call-service');
const { CallSettings } = require('./call-settings');
const { MicrophonePreference } = require('./microphone-preference');
const { RecorderController } = require('./controller');
const { CaptureHealthAlerts, presentCaptureAlert } = require('./capture-health-alerts');
const { Connectivity } = require('./connectivity');
const { MicWatcher } = require('./mic-watcher');
const { createCallPrompt } = require('./call-prompt');
const { IPC } = require('./protocol');
const { isRecordingIcon, trayItems, traySignature, trayTooltip } = require('./tray-model');

const CALLS_CHANGED_DEBOUNCE_MS = 250;
const SIGN_IN_DEBOUNCE_MS = 3000;
const QUIT_STOP_MS = 5000;
const QUIT_PERSIST_MS = 3000;

function debounce(fn, ms) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
    timer.unref?.();
  };
}

// Wires the recorder into the Electron app: capture, the call pipeline, the recorder window,
// power and network events, notifications. main.js only owns the tray and the app lifecycle.
// Events: 'state' (recorder state string changed), 'tray' { status, menuChanged, iconChanged, tooltip, recording }.
function createDesktopRecorder({ electron, appRoot, recordingsRoot, userData, helperPath, getOrigin,
  getMainWindow, signIn, openKernUrl, log = console }) {
  const { BrowserWindow, ipcMain, dialog, clipboard, powerMonitor, powerSaveBlocker, Notification, net, session } = electron;
  const events = new EventEmitter();
  const settings = new CallSettings(path.join(userData, 'call-settings.json'));
  const microphones = new MicrophonePreference(path.join(userData, 'recorder-settings.json'));
  const supervisor = new RecorderSupervisor({ recordingsRoot, helperPath, powerSaveBlocker });
  const http = new CallHttp({ getSession: () => session.defaultSession, getOrigin });
  const pipeline = new CallPipeline({
    root: recordingsRoot, http,
    live: (id) => supervisor.liveCapture(id),
    defaultTranscribe: () => { const s = settings.get(); return s.enabled && s.noticeAcknowledged; },
  });
  const service = new CallService({ root: recordingsRoot, pipeline, supervisor });
  const controller = new RecorderController({
    BrowserWindow, ipcMain, dialog, clipboard, appRoot, getParentWindow: getMainWindow,
    supervisor, pipeline, service, settings, microphones, signIn, openKernUrl,
  });
  const callPrompt = createCallPrompt({
    watcher: new MicWatcher({ helperPath, log }), settings, supervisor, Notification, log,
    start: () => controller.start(), showRecorder: () => controller.show(),
  });
  const alerts = new CaptureHealthAlerts();
  const connectivity = new Connectivity({ isOnline: () => net.isOnline() });
  const report = (what) => (error) => log.error(`Recorder ${what} failed:`, error?.message || error);
  const callsChanged = debounce(() => controller.send(IPC.CALLS_CHANGED, {}), CALLS_CHANGED_DEBOUNCE_MS);

  let lastState = null, lastSignature = null, lastTooltip = null, lastRecording = null;
  supervisor.on('status', (status) => {
    controller.send(IPC.STATUS, status);
    if (status.state !== lastState) {
      lastState = status.state;
      events.emit('state', status);
      callsChanged();
    }
    const signature = traySignature(status), tooltip = trayTooltip(status), recording = isRecordingIcon(status);
    if (signature !== lastSignature || tooltip !== lastTooltip || recording !== lastRecording) {
      events.emit('tray', { status, menuChanged: signature !== lastSignature, tooltip, recording, iconChanged: recording !== lastRecording });
      lastSignature = signature; lastTooltip = tooltip; lastRecording = recording;
    }
    presentCaptureAlert(alerts.update(status), { showRecorder: () => controller.show(), Notification, reportError: report('alert') });
  });
  supervisor.on('started', ({ sessionId, context }) => {
    pipeline.onStarted(sessionId, { transcribe: context?.transcribe === true }).catch(report('call start'));
  });
  supervisor.on('ended', (detail) => {
    pipeline.onEnded(detail).catch(report('call end'));
  });

  pipeline.on('change', callsChanged);
  // One notification per call, when its summary thread exists in Kern. Clicking opens that thread.
  pipeline.on('summary', ({ sessionId }) => {
    try {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: 'Call summary ready', body: 'Click to open it in Kern.' });
      notification.on('click', () => {
        service.summaryUrl(sessionId).then(({ url }) => openKernUrl(url)).catch(report('open summary'));
      });
      notification.show();
    } catch (error) { report('notification')(error); }
  });

  powerMonitor.on('suspend', () => supervisor.onSystemSuspend());
  powerMonitor.on('resume', () => {
    supervisor.onSystemResume().catch(report('resume')).finally(() => pipeline.kick());
  });
  connectivity.on('online', () => pipeline.kick());
  connectivity.start();
  const signInChanged = debounce(() => pipeline.kick(), SIGN_IN_DEBOUNCE_MS);
  session.defaultSession?.cookies?.on?.('changed', signInChanged);
  pipeline.start().catch(report('launch reconcile'));
  callPrompt.start();

  return Object.assign(events, {
    supervisor, pipeline,
    show: () => controller.show(),
    openCall: (sessionId) => controller.openCall(sessionId),
    isActive: () => supervisor.isActive(),
    snapshot: () => supervisor.snapshot(),
    trayItems: (status = supervisor.snapshot()) => trayItems(status),
    runTrayAction(action) {
      if (action === 'show') { controller.show(); return; }
      const command = { pause: () => supervisor.pause(), resume: () => supervisor.resume(), stop: () => supervisor.stop() }[action];
      command?.().catch((error) => { report(action)(error); controller.show(); });
    },
    // The Kern page loaded or its cookies changed: a sign-in may have happened.
    signInMayHaveChanged: signInChanged,
    // Stop and quit: the stop and the call's final length are on disk before the app exits.
    async shutdownForQuit() {
      callPrompt.stop();
      await supervisor.shutdownForQuit({ timeoutMs: QUIT_STOP_MS });
      connectivity.stop();
      // Cancels in-flight uploads at once, then waits (bounded) for queued work, which includes
      // saving the stopped call's final length (pipeline.onEnded, queued by the stop above).
      await pipeline.close({ timeoutMs: QUIT_PERSIST_MS });
    },
    destroy() {
      callPrompt.stop();
      connectivity.stop();
      session.defaultSession?.cookies?.off?.('changed', signInChanged);
      controller.destroy();
    },
  });
}

module.exports = { createDesktopRecorder };
