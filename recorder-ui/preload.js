'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload cannot import app modules. Keep this closed map in sync with
// recorder/protocol.js (test/call-ipc.test.js checks that it is).
const IPC = Object.freeze({
  STATUS: 'kern-recorder:status',
  CALLS_CHANGED: 'kern-recorder:calls-changed',
  OPEN_CALL: 'kern-recorder:open-call',
  GET_STATUS: 'kern-recorder:get-status',
  GET_SETUP: 'kern-recorder:get-setup',
  LIST_DEVICES: 'kern-recorder:list-devices',
  SET_MICROPHONE: 'kern-recorder:set-microphone',
  SET_TRANSCRIPTION: 'kern-recorder:set-transcription',
  ACKNOWLEDGE_NOTICE: 'kern-recorder:acknowledge-notice',
  START: 'kern-recorder:start',
  PAUSE: 'kern-recorder:pause',
  RESUME: 'kern-recorder:resume',
  SET_MIC_MUTED: 'kern-recorder:set-mic-muted',
  STOP: 'kern-recorder:stop',
  LIST_CALLS: 'kern-recorder:list-calls',
  GET_CALL: 'kern-recorder:get-call',
  RENAME_CALL: 'kern-recorder:rename-call',
  RETRY_CALL: 'kern-recorder:retry-call',
  DELETE_CALL: 'kern-recorder:delete-call',
  COPY_TRANSCRIPT: 'kern-recorder:copy-transcript',
  COPY_DIAGNOSTICS: 'kern-recorder:copy-diagnostics',
  OPEN_SUMMARY: 'kern-recorder:open-summary',
  SIGN_IN: 'kern-recorder:sign-in',
});

function subscribe(channel) {
  return (listener) => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  };
}

contextBridge.exposeInMainWorld('kernRecorder', Object.freeze({
  getStatus: () => ipcRenderer.invoke(IPC.GET_STATUS),
  getSetup: () => ipcRenderer.invoke(IPC.GET_SETUP),
  listDevices: () => ipcRenderer.invoke(IPC.LIST_DEVICES),
  setMicrophone: (selection) => ipcRenderer.invoke(IPC.SET_MICROPHONE, selection),
  setTranscription: (enabled) => ipcRenderer.invoke(IPC.SET_TRANSCRIPTION, { enabled }),
  acknowledgeNotice: () => ipcRenderer.invoke(IPC.ACKNOWLEDGE_NOTICE),
  start: () => ipcRenderer.invoke(IPC.START),
  pause: () => ipcRenderer.invoke(IPC.PAUSE),
  resume: () => ipcRenderer.invoke(IPC.RESUME),
  setMicMuted: (muted) => ipcRenderer.invoke(IPC.SET_MIC_MUTED, { muted }),
  stop: () => ipcRenderer.invoke(IPC.STOP),
  listCalls: () => ipcRenderer.invoke(IPC.LIST_CALLS),
  getCall: (sessionId) => ipcRenderer.invoke(IPC.GET_CALL, { sessionId }),
  renameCall: (sessionId, title) => ipcRenderer.invoke(IPC.RENAME_CALL, { sessionId, title }),
  retryCall: (sessionId) => ipcRenderer.invoke(IPC.RETRY_CALL, { sessionId }),
  deleteCall: (sessionId) => ipcRenderer.invoke(IPC.DELETE_CALL, { sessionId }),
  copyTranscript: (sessionId, format) => ipcRenderer.invoke(IPC.COPY_TRANSCRIPT, { sessionId, format }),
  copyDiagnostics: (sessionId) => ipcRenderer.invoke(IPC.COPY_DIAGNOSTICS, { sessionId }),
  openSummary: (sessionId) => ipcRenderer.invoke(IPC.OPEN_SUMMARY, { sessionId }),
  signIn: () => ipcRenderer.invoke(IPC.SIGN_IN),
  onStatus: subscribe(IPC.STATUS),
  onCallsChanged: subscribe(IPC.CALLS_CHANGED),
  onOpenCall: subscribe(IPC.OPEN_CALL),
}));
