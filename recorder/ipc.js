'use strict';

const { EVENT_CHANNELS, REQUEST_CHANNELS, validateRendererPayload } = require('./protocol');

// Only the bundled recorder page, in its own top frame, may call these handlers. The main Kern
// window loads a remote site and must never gain capture or file authority through this bridge.
function registerRecorderIpc({ ipcMain, getRecorderWindow, handlers, trustedRecorderUrl }) {
  if (typeof trustedRecorderUrl !== 'string' || !trustedRecorderUrl.startsWith('file:')) {
    throw new TypeError('A bundled recorder URL is required');
  }
  for (const channel of REQUEST_CHANNELS) {
    if (typeof handlers[channel] !== 'function') throw new TypeError(`Missing recorder handler for ${channel}`);
  }
  const trustedWindow = () => {
    const window = getRecorderWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null;
    return window.webContents.getURL() === trustedRecorderUrl ? window : null;
  };
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
  for (const channel of REQUEST_CHANNELS) {
    ipcMain.handle(channel, async (event, rawPayload) => {
      assertLocalRecorderSender(event);
      return handlers[channel](validateRendererPayload(channel, rawPayload));
    });
  }
  return {
    // Push an event to the recorder page, if it is open and still the bundled page.
    send(channel, payload) {
      if (!EVENT_CHANNELS.includes(channel)) throw new TypeError('Unknown recorder event channel');
      trustedWindow()?.webContents.send(channel, payload);
    },
    dispose() {
      for (const channel of REQUEST_CHANNELS) ipcMain.removeHandler(channel);
    },
  };
}

module.exports = { REQUEST_CHANNELS, registerRecorderIpc };
