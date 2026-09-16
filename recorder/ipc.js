'use strict';

const { IPC, validateRendererPayload } = require('./protocol');
const REQUEST_CHANNELS = Object.freeze(Object.values(IPC).filter(channel => channel !== IPC.STATUS));

function registerRecorderIpc({ ipcMain, getRecorderWindow, supervisor, handlers, trustedRecorderUrl }) {
  if (typeof trustedRecorderUrl !== 'string' || !trustedRecorderUrl.startsWith('file:')) {
    throw new TypeError('A bundled recorder URL is required');
  }
  const assertLocalRecorderSender = event => {
    const window = getRecorderWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error('Recorder window is unavailable');
    }
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Recorder IPC is restricted to the bundled recorder window');
    }
    if (window.webContents.getURL() !== trustedRecorderUrl || event.senderFrame?.url !== trustedRecorderUrl) {
      throw new Error('Recorder IPC caller URL is not trusted');
    }
  };
  const operations = {
    [IPC.GET_STATUS]: () => supervisor.snapshot(),
    [IPC.LIST_DEVICES]: () => supervisor.listDevices(),
    [IPC.LIST_SESSIONS]: () => handlers.listSessions(),
    [IPC.GET_SESSION]: payload => handlers.getSession(payload.sessionId),
    [IPC.START]: payload => supervisor.start(payload),
    [IPC.PAUSE]: () => supervisor.pause(),
    [IPC.RESUME]: () => supervisor.resume(),
    [IPC.SET_MIC_MUTED]: payload => supervisor.setMicMuted(payload.muted),
    [IPC.STOP]: () => supervisor.stop(),
    [IPC.RECOVER]: payload => supervisor.recover(payload.sessionId),
    [IPC.GET_PLAYBACK_URL]: payload => handlers.getPlaybackUrl(payload),
    [IPC.EXPORT]: payload => handlers.exportSession(payload.sessionId),
    [IPC.SHOW_IN_FOLDER]: payload => handlers.showInFolder(payload.sessionId),
    [IPC.GET_CALL]: payload => handlers.getCall(payload.sessionId),
    [IPC.PREPARE_CALL]: payload => handlers.prepareCall(payload.sessionId),
    [IPC.TRANSCRIBE]: payload => handlers.transcribe(payload.sessionId),
    [IPC.EXPORT_TRANSCRIPT]: payload => handlers.exportTranscript(payload.sessionId),
    [IPC.COPY_TRANSCRIPT]: payload => handlers.copyTranscript(payload.sessionId),
    [IPC.GET_TRANSCRIPTION_ENABLED]: () => handlers.getTranscriptionEnabled(),
    [IPC.SET_TRANSCRIPTION_ENABLED]: payload => handlers.setTranscriptionEnabled(payload.enabled),
    [IPC.SIGN_IN]: () => handlers.signIn(),
  };
  for (const channel of REQUEST_CHANNELS) {
    ipcMain.handle(channel, async (event, rawPayload) => {
      assertLocalRecorderSender(event);
      return operations[channel](validateRendererPayload(channel, rawPayload));
    });
  }
  const onStatus = status => {
    const window = getRecorderWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()
      && window.webContents.getURL() === trustedRecorderUrl) {
      window.webContents.send(IPC.STATUS, status);
    }
  };
  supervisor.on('status', onStatus);
  return () => {
    supervisor.off('status', onStatus);
    for (const channel of REQUEST_CHANNELS) ipcMain.removeHandler(channel);
  };
}
module.exports = { REQUEST_CHANNELS, registerRecorderIpc };
