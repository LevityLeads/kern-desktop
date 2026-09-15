'use strict';

const path = require('path');

function createRecorderWindow({ BrowserWindow, appRoot, parent }) {
  const window = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 680,
    minHeight: 600,
    parent: parent || undefined,
    modal: false,
    show: false,
    title: 'Kern recorder',
    backgroundColor: '#0a0614',
    icon: path.join(appRoot, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      preload: path.join(appRoot, 'recorder-ui', 'preload.js'),
    },
  });

  window.setMenuBarVisibility(false);
  window.loadFile(path.join(appRoot, 'recorder-ui', 'index.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  return window;
}

module.exports = { createRecorderWindow };
