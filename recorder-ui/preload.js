'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload scripts can require Electron, but cannot import arbitrary
// application modules. Keep this closed channel map in lockstep with protocol.js.
const IPC = Object.freeze({
  STATUS: 'kern-recorder:status',
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
});

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('kernRecorder', Object.freeze({
  listDevices: () => invoke(IPC.LIST_DEVICES),
  listSessions: () => invoke(IPC.LIST_SESSIONS),
  getSession: (sessionId) => invoke(IPC.GET_SESSION, { sessionId }),
  start: (microphone) => invoke(IPC.START, { microphone, consentAcknowledged: true }),
  pause: () => invoke(IPC.PAUSE),
  resume: () => invoke(IPC.RESUME),
  setMicMuted: (muted) => invoke(IPC.SET_MIC_MUTED, { muted }),
  stop: () => invoke(IPC.STOP),
  recover: (sessionId) => invoke(IPC.RECOVER, { sessionId }),
  playbackUrl: (sessionId, trackId, segmentId) =>
    invoke(IPC.GET_PLAYBACK_URL, { sessionId, trackId, segmentId }),
  exportSession: (sessionId) => invoke(IPC.EXPORT, { sessionId }),
  showInFolder: (sessionId) => invoke(IPC.SHOW_IN_FOLDER, { sessionId }),
  onStatus: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('status listener must be a function');
    const wrapped = (_event, status) => listener(status);
    ipcRenderer.on(IPC.STATUS, wrapped);
    return () => ipcRenderer.removeListener(IPC.STATUS, wrapped);
  },
}));
