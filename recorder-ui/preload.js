'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload cannot import arbitrary modules. Keep this closed map in sync.
const IPC = Object.freeze({
  STATUS: 'kern-recorder:status',
  GET_STATUS: 'kern-recorder:get-status',
  LIST_DEVICES: 'kern-recorder:list-devices',
  LIST_SESSIONS: 'kern-recorder:list-sessions',
  GET_SESSION: 'kern-recorder:get-session',
  START: 'kern-recorder:start',
  PAUSE: 'kern-recorder:pause',
  RESUME: 'kern-recorder:resume',
  SET_MIC_MUTED: 'kern-recorder:set-mic-muted',
  STOP: 'kern-recorder:stop',
  RECOVER: 'kern-recorder:recover',
  GET_PLAYBACK_URL: 'kern-recorder:get-playback-url',
  EXPORT: 'kern-recorder:export',
  SHOW_IN_FOLDER: 'kern-recorder:show-in-folder',
  GET_CALL: 'kern-recorder:get-call',
  PREPARE_CALL: 'kern-recorder:prepare-call',
  TRANSCRIBE: 'kern-recorder:transcribe',
  EXPORT_TRANSCRIPT: 'kern-recorder:export-transcript',
  COPY_TRANSCRIPT: 'kern-recorder:copy-transcript',
  GET_TRANSCRIPTION_ENABLED: 'kern-recorder:get-transcription-enabled',
  SET_TRANSCRIPTION_ENABLED: 'kern-recorder:set-transcription-enabled',
  SIGN_IN: 'kern-recorder:sign-in',
});

contextBridge.exposeInMainWorld('kernRecorder', Object.freeze({
  getStatus: () => ipcRenderer.invoke(IPC.GET_STATUS),
  listDevices: () => ipcRenderer.invoke(IPC.LIST_DEVICES),
  listSessions: () => ipcRenderer.invoke(IPC.LIST_SESSIONS),
  getSession: (sessionId) => ipcRenderer.invoke(IPC.GET_SESSION, { sessionId }),
  start: (microphone) => ipcRenderer.invoke(IPC.START, { microphone, consentAcknowledged: true }),
  pause: () => ipcRenderer.invoke(IPC.PAUSE),
  resume: () => ipcRenderer.invoke(IPC.RESUME),
  setMicMuted: (muted) => ipcRenderer.invoke(IPC.SET_MIC_MUTED, { muted }),
  stop: () => ipcRenderer.invoke(IPC.STOP),
  recover: (sessionId) => ipcRenderer.invoke(IPC.RECOVER, { sessionId }),
  playbackUrl: (sessionId, trackId, segmentId) => ipcRenderer.invoke(IPC.GET_PLAYBACK_URL, { sessionId, trackId, segmentId }),
  exportSession: (sessionId) => ipcRenderer.invoke(IPC.EXPORT, { sessionId }),
  showInFolder: (sessionId) => ipcRenderer.invoke(IPC.SHOW_IN_FOLDER, { sessionId }),
  getCall: (sessionId) => ipcRenderer.invoke(IPC.GET_CALL, { sessionId }),
  prepareCall: (sessionId) => ipcRenderer.invoke(IPC.PREPARE_CALL, { sessionId }),
  transcribe: (sessionId) => ipcRenderer.invoke(IPC.TRANSCRIBE, { sessionId }),
  exportTranscript: (sessionId) => ipcRenderer.invoke(IPC.EXPORT_TRANSCRIPT, { sessionId }),
  copyTranscript: (sessionId) => ipcRenderer.invoke(IPC.COPY_TRANSCRIPT, { sessionId }),
  getTranscriptionEnabled: () => ipcRenderer.invoke(IPC.GET_TRANSCRIPTION_ENABLED),
  setTranscriptionEnabled: (enabled) => ipcRenderer.invoke(IPC.SET_TRANSCRIPTION_ENABLED, { enabled }),
  signIn: () => ipcRenderer.invoke(IPC.SIGN_IN),
  onStatus: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('status listener must be a function');
    const wrapped = (_event, status) => listener(status);
    ipcRenderer.on(IPC.STATUS, wrapped);
    return () => ipcRenderer.removeListener(IPC.STATUS, wrapped);
  },
}));
