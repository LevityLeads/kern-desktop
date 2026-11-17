'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

// Keep in sync with recorder-ui/prompt-preload.js (test/prompt-card.test.js checks that it is).
const CHANNEL = 'kern-call-prompt:choose';
const CHOICES = Object.freeze(['record', 'dismiss']);
const WIDTH = 400;
const HEIGHT = 188;
const MARGIN = 16;
const MAX_APP_LENGTH = 40;

function withoutQuery(url) {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch { return null; }
}

// The "Record this call?" card: a small frameless window above every other window, a full-screen
// call included, in the top-right corner of the screen the pointer is on. It never takes focus
// from the call and stays until the user answers or the caller closes it. It replaces a Windows
// notification, which Windows drops silently when notifications or Focus Assist are off.
// One card at a time; showing a new one replaces the old one without answering it.
class PromptCard {
  constructor({ BrowserWindow, ipcMain, screen, appRoot, log = console }) {
    Object.assign(this, { BrowserWindow, ipcMain, screen, log });
    this.page = path.join(appRoot, 'recorder-ui', 'prompt.html');
    this.trustedUrl = pathToFileURL(this.page).href;
    this.preload = path.join(appRoot, 'recorder-ui', 'prompt-preload.js');
    this.window = null;
    this.handlers = null;
    this.onChoose = (event, choice) => this.choose(event, choice);
    ipcMain.on(CHANNEL, this.onChoose);
  }

  get isOpen() {
    return Boolean(this.window && !this.window.isDestroyed());
  }

  // app: the display name shown in the card. onRecord / onDismiss: called at most once, and never
  // after close(). Closing the window by hand (Alt+F4) counts as dismiss.
  show({ app, onRecord, onDismiss }) {
    this.close();
    const { x, y } = this.position();
    const window = new this.BrowserWindow({
      x, y, width: WIDTH, height: HEIGHT,
      show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      title: 'Record this call?', backgroundColor: '#1c1c1c',
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
        navigateOnDragDrop: false, preload: this.preload,
      },
    });
    this.window = window;
    this.handlers = { record: onRecord, dismiss: onDismiss };
    // 'screen-saver' outranks a full-screen browser or Teams window; the default level does not.
    window.setAlwaysOnTop(true, 'screen-saver');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.showInactive(); });
    window.on('closed', () => {
      if (this.window !== window) return; // replaced or closed through close(): nobody answered
      this.window = null;
      this.answer('dismiss');
    });
    window.loadFile(this.page, { query: { app: String(app ?? '').slice(0, MAX_APP_LENGTH) } })
      .catch((error) => this.log.error('Call prompt card failed to load:', error?.message || error));
  }

  // Withdraws the card without answering it.
  close() {
    const window = this.window;
    this.window = null;
    this.handlers = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  dispose() {
    this.close();
    this.ipcMain.removeListener(CHANNEL, this.onChoose);
  }

  // Only the bundled card page, in the card window's own top frame, may answer.
  choose(event, choice) {
    const window = this.window;
    if (!window || window.isDestroyed() || event?.sender !== window.webContents) return;
    const frame = event.senderFrame;
    if (!frame || frame !== window.webContents.mainFrame || withoutQuery(frame.url) !== this.trustedUrl) return;
    if (!CHOICES.includes(choice)) return;
    this.window = null;
    window.destroy();
    this.answer(choice);
  }

  answer(choice) {
    const handler = this.handlers?.[choice];
    this.handlers = null;
    try { handler?.(); } catch (error) { this.log.error('Call prompt card handler failed:', error?.message || error); }
  }

  position() {
    const { workArea } = this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint());
    return {
      x: Math.round(workArea.x + workArea.width - WIDTH - MARGIN),
      y: Math.round(workArea.y + MARGIN),
    };
  }
}

module.exports = { CHANNEL, CHOICES, HEIGHT, MARGIN, PromptCard, WIDTH };
