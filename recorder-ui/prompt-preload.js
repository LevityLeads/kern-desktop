'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload cannot import app modules. Keep in sync with recorder/prompt-card.js
// (test/prompt-card.test.js checks that it is). Main validates the sender and the answer again.
const CHANNEL = 'kern-call-prompt:choose';

contextBridge.exposeInMainWorld('kernCallPrompt', Object.freeze({
  choose: (choice) => ipcRenderer.send(CHANNEL, choice === 'record' ? 'record' : 'dismiss'),
}));
