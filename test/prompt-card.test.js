'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { CHANNEL, HEIGHT, MARGIN, PromptCard, WIDTH } = require('../recorder/prompt-card');

const ROOT = path.join(__dirname, '..');
const PAGE_URL = pathToFileURL(path.join(ROOT, 'recorder-ui', 'prompt.html')).href;

function rig() {
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.shown = null;
      this.alwaysOnTop = null;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: '' }, openHandler: null,
        setWindowOpenHandler(fn) { this.openHandler = fn; },
      });
      windows.push(this);
    }
    setAlwaysOnTop(flag, level) { this.alwaysOnTop = [flag, level]; }
    loadFile(file, { query }) {
      this.loaded = { file, query };
      this.webContents.mainFrame.url = `${pathToFileURL(file).href}?${new URLSearchParams(query)}`;
      return Promise.resolve();
    }
    showInactive() { this.shown = 'inactive'; }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  }
  const ipcMain = new EventEmitter();
  const screen = {
    getCursorScreenPoint: () => ({ x: 2500, y: 300 }),
    getDisplayNearestPoint: ({ x }) => (x > 1920
      ? { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }
      : { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  };
  const card = new PromptCard({ BrowserWindow: FakeWindow, ipcMain, screen, appRoot: ROOT, log: { error() {} } });
  const answers = [];
  const show = (app = 'Chrome') => card.show({ app, onRecord: () => answers.push('record'), onDismiss: () => answers.push('dismiss') });
  // What the card page sends, from its own window unless told otherwise.
  const send = (choice, window = windows.at(-1), frame = window.webContents.mainFrame) =>
    ipcMain.emit(CHANNEL, { sender: window.webContents, senderFrame: frame }, choice);
  return { card, windows, ipcMain, answers, show, send };
}

test('shows a frameless always-on-top card in the top-right of the screen the pointer is on, without taking focus', () => {
  const r = rig();
  r.show('Chrome');
  const [window] = r.windows;
  assert.equal(window.options.frame, false);
  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.options.show, false);
  assert.deepEqual(window.alwaysOnTop, [true, 'screen-saver']);
  assert.equal(window.options.x, 1920 + 2560 - WIDTH - MARGIN);
  assert.equal(window.options.y, MARGIN);
  assert.equal(window.options.height, HEIGHT);
  assert.deepEqual(window.loaded.query, { app: 'Chrome' });
  window.emit('ready-to-show');
  assert.equal(window.shown, 'inactive');
  assert.equal(r.card.isOpen, true);
});

test('the card page is sandboxed and cannot navigate or open windows', () => {
  const r = rig();
  r.show();
  const [window] = r.windows;
  const prefs = window.options.webPreferences;
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.deepEqual(window.webContents.openHandler(), { action: 'deny' });
  let prevented = false;
  window.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://evil.example');
  assert.equal(prevented, true);
});

test('Record answers once and closes the card', () => {
  const r = rig();
  r.show();
  r.send('record');
  r.send('record');
  assert.deepEqual(r.answers, ['record']);
  assert.equal(r.card.isOpen, false);
  assert.equal(r.windows[0].destroyed, true);
});

test('Not now answers dismiss', () => {
  const r = rig();
  r.show();
  r.send('dismiss');
  assert.deepEqual(r.answers, ['dismiss']);
});

test('closing the card window by hand counts as Not now', () => {
  const r = rig();
  r.show();
  r.windows[0].destroy();
  assert.deepEqual(r.answers, ['dismiss']);
});

test('close() withdraws the card without answering', () => {
  const r = rig();
  r.show();
  r.card.close();
  assert.deepEqual(r.answers, []);
  assert.equal(r.windows[0].destroyed, true);
});

test('a new card replaces the old one without answering it', () => {
  const r = rig();
  r.show('Teams');
  r.show('Zoom');
  assert.deepEqual(r.answers, []);
  assert.equal(r.windows[0].destroyed, true);
  r.send('record');
  assert.deepEqual(r.answers, ['record']);
});

test('answers from anywhere but the card page are ignored', () => {
  const r = rig();
  r.show();
  const [window] = r.windows;
  const other = { webContents: new EventEmitter() };
  other.webContents.mainFrame = { url: PAGE_URL };
  r.send('record', other, other.webContents.mainFrame);               // another window
  r.send('record', window, { url: PAGE_URL });                        // a subframe
  window.webContents.mainFrame.url = 'https://kern.example/prompt';   // navigated away
  r.send('record');
  window.webContents.mainFrame.url = `${PAGE_URL}?app=Chrome`;
  r.send('delete-everything');                                        // not an answer
  r.send(undefined);
  assert.deepEqual(r.answers, []);
  assert.equal(r.card.isOpen, true);
  r.send('record');
  assert.deepEqual(r.answers, ['record']);
});

test('long app names are cut before they reach the page', () => {
  const r = rig();
  r.show('x'.repeat(500));
  assert.equal(r.windows[0].loaded.query.app.length, 40);
});

test('dispose() removes the IPC listener and closes the card', () => {
  const r = rig();
  r.show();
  r.card.dispose();
  assert.equal(r.ipcMain.listenerCount(CHANNEL), 0);
  assert.equal(r.card.isOpen, false);
});

test('the sandboxed preload uses the channel main listens on', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'recorder-ui', 'prompt-preload.js'), 'utf8');
  assert.match(preload, new RegExp(`const CHANNEL = '${CHANNEL}';`));
});

test('electron-builder ships the card page', () => {
  const config = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  assert.match(config, /- recorder-ui\/\*\*\/\*/);
  for (const file of ['prompt.html', 'prompt.js', 'prompt.css', 'prompt-preload.js', 'tokens.css']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'recorder-ui', file)), file);
  }
});

// The card page itself, run against a minimal DOM.
function page(search) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, Object.assign(new EventEmitter(), { id, textContent: '', addEventListener(type, fn) { this.on(type, fn); } }));
    return elements.get(id);
  };
  const document = Object.assign(new EventEmitter(), { getElementById: element, addEventListener(type, fn) { this.on(type, fn); } });
  const sent = [];
  const window = { location: { search }, kernCallPrompt: { choose: (choice) => sent.push(choice) } };
  const context = vm.createContext({ window, document, URLSearchParams });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'recorder-ui', 'prompt.js'), 'utf8'), context);
  return { element, document, sent };
}

test('the page names the app as text and sends one answer', () => {
  const p = page('?app=%3Cimg%20src%3Dx%3EChrome');
  assert.equal(p.element('prompt-app').textContent, '<img src=x>Chrome');
  p.element('prompt-record').emit('click');
  p.element('prompt-dismiss').emit('click');
  assert.deepEqual(p.sent, ['record']);
});

test('the page sends dismiss for Not now, the close button and Escape', () => {
  for (const act of [
    (p) => p.element('prompt-dismiss').emit('click'),
    (p) => p.element('prompt-close').emit('click'),
    (p) => p.document.emit('keydown', { key: 'Escape' }),
  ]) {
    const p = page('?app=Teams');
    act(p);
    assert.deepEqual(p.sent, ['dismiss']);
  }
});

test('the page HTML holds every element the script uses and no em dashes', () => {
  const html = fs.readFileSync(path.join(ROOT, 'recorder-ui', 'prompt.html'), 'utf8');
  for (const id of ['prompt-app', 'prompt-record', 'prompt-dismiss', 'prompt-close']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /[–—]/);
});
