const { contextBridge, ipcRenderer } = require('electron');

// ipcRenderer itself is never exposed, only these narrow wrappers.
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,

  // Open an http(s) URL in a specific browser. Resolves true if launched.
  openUrl: (url, browser) => ipcRenderer.invoke('kern:open-url', url, browser),

  // Which of "chrome" / "edge" are installed on this machine.
  availableBrowsers: () => ipcRenderer.invoke('kern:available-browsers'),
});
