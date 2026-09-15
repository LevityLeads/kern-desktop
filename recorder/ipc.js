'use strict';

const { IPC, validateRendererPayload } = require('./protocol');

const REQUEST_CHANNELS = Object.freeze([
  IPC.LIST_DEVICES,
  IPC.LIST_SESSIONS,
  IPC.GET_SESSION,
  IPC.START,
  IPC.PAUSE,
  IPC.RESUME,
  IPC.SET_MIC_MUTED,
  IPC.STOP,
  IPC.RECOVER,
  IPC.GET_PLAYBACK_URL,
  IPC.EXPORT,
  IPC.SHOW_IN_FOLDER,
]);

function registerRecorderIpc({ ipcMain, getRecorderWindow, supervisor, handlers }) {
  const assertLocalRecorderSender = (event) => {
    const recorderWindow = getRecorderWindow();
    const senderFrame = event.senderFrame;
    if (!recorderWindow || recorderWindow.isDestroyed()) throw new Error('Recorder window is unavailable');
    if (event.sender !== recorderWindow.webContents || senderFrame !== recorderWindow.webContents.mainFrame) {
      throw new Error('Recorder IPC is restricted to the bundled recorder window');
    }
    const expectedUrl = recorderWindow.webContents.getURL();
    if (!expectedUrl.startsWith('file:') || senderFrame.url !== expectedUrl) {
      throw new Error('Recorder IPC caller URL is not trusted');
    }
  };

  const operations = {
    [IPC.LIST_DEVICES]: () => supervisor.listDevices(),
    [IPC.LIST_SESSIONS]: () => handlers.listSessions(),
    [IPC.GET_SESSION]: (payload) => handlers.getSession(payload.sessionId),
    [IPC.START]: (payload) => supervisor.start(payload),
    [IPC.PAUSE]: () => supervisor.pause(),
    [IPC.RESUME]: () => supervisor.resume(),
    [IPC.SET_MIC_MUTED]: (payload) => supervisor.setMicMuted(payload.muted),
    [IPC.STOP]: () => supervisor.stop(),
    [IPC.RECOVER]: (payload) => supervisor.recover(payload.sessionId),
    [IPC.GET_PLAYBACK_URL]: (payload) => handlers.getPlaybackUrl(payload),
    [IPC.EXPORT]: (payload) => handlers.exportSession(payload.sessionId),
    [IPC.SHOW_IN_FOLDER]: (payload) => handlers.showInFolder(payload.sessionId),
  };

  for (const channel of REQUEST_CHANNELS) {
    ipcMain.handle(channel, async (event, rawPayload) => {
      assertLocalRecorderSender(event);
      const payload = validateRendererPayload(channel, rawPayload);
      return operations[channel](payload);
    });
  }

  const onStatus = (status) => {
    const window = getRecorderWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
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
