'use strict';

const fs = require('fs');
const path = require('path');
const { dialog, shell } = require('electron');
const { registerRecorderIpc } = require('./ipc');
const catalog = require('./session-catalog');
const { createRecorderWindow } = require('./window');

class RecorderController {
  constructor({ BrowserWindow, ipcMain, supervisor, appRoot, recordingsRoot, getParentWindow }) {
    this.BrowserWindow = BrowserWindow;
    this.ipcMain = ipcMain;
    this.supervisor = supervisor;
    this.appRoot = appRoot;
    this.recordingsRoot = recordingsRoot;
    this.getParentWindow = getParentWindow;
    this.window = null;
    this.disposeIpc = registerRecorderIpc({
      ipcMain,
      getRecorderWindow: () => this.window,
      supervisor,
      handlers: {
        listSessions: () => catalog.listSessions(recordingsRoot),
        getSession: (sessionId) => catalog.readManifest(recordingsRoot, sessionId),
        getPlaybackUrl: (payload) => catalog.buildPlaybackUrl(recordingsRoot, payload),
        exportSession: (sessionId) => this.exportSession(sessionId),
        showInFolder: (sessionId) => this.showInFolder(sessionId),
      },
    });
  }

  show() {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return this.window;
    }
    this.window = createRecorderWindow({
      BrowserWindow: this.BrowserWindow,
      appRoot: this.appRoot,
      parent: this.getParentWindow(),
    });
    this.window.on('closed', () => {
      this.window = null;
    });
    return this.window;
  }

  async exportSession(sessionId) {
    const result = await dialog.showOpenDialog(this.window || this.getParentWindow(), {
      title: 'Export Kern recording',
      buttonLabel: 'Export here',
      defaultPath: path.join(process.env.USERPROFILE || process.cwd(), 'Documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const destination = catalog.exportSession(this.recordingsRoot, sessionId, result.filePaths[0]);
    shell.showItemInFolder(path.join(destination, catalog.MANIFEST_NAME));
    return { canceled: false, destination };
  }

  showInFolder(sessionId) {
    const manifest = catalog.readManifest(this.recordingsRoot, sessionId);
    const manifestFile = catalog.manifestPath(this.recordingsRoot, sessionId);
    if (!fs.existsSync(manifestFile) || manifest.sessionId !== sessionId) {
      throw new Error('Recording manifest was not found');
    }
    shell.showItemInFolder(manifestFile);
    return { ok: true };
  }

  destroy() {
    this.disposeIpc?.();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { RecorderController };
