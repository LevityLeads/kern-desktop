const { contextBridge, ipcRenderer } = require('electron');

// Minimal surface for the first-run setup page. Deliberately does not
// expose ipcRenderer itself, only the two calls setup.html needs.
contextBridge.exposeInMainWorld('kernSetup', {
  save: (url) => ipcRenderer.invoke('kern-setup:save', url),
  cancel: () => ipcRenderer.invoke('kern-setup:cancel'),
});
