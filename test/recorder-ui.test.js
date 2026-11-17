'use strict';

// Runs the real recorder-ui scripts against a minimal DOM stand-in, so the screens and their
// state changes are exercised without Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI = path.join(__dirname, '../recorder-ui');
const SCRIPTS = [...fs.readFileSync(path.join(UI, 'index.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const ID = '9b918241-3cb0-447c-8861-8f14358563e7';
const settle = () => new Promise((resolve) => setImmediate(resolve));

class Node {
  constructor(tag = 'div') {
    Object.assign(this, { tag, children: [], hidden: false, disabled: false, value: '', dataset: {}, style: {}, listeners: {}, className: '' });
    this._text = '';
    this.classList = { set: new Set(), toggle: (name, on) => (on ? this.classList.set.add(name) : this.classList.set.delete(name)) };
  }
  get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append(...nodes) { for (const n of nodes) this.children.push(...(n?.fragment ? n.children : [n])); }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  closest() { return this; }
  focus() {}
  blur() {}
}

function load(apiOverrides = {}) {
  const nodes = new Map();
  const document = {
    activeElement: null,
    getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); },
    createElement: (tag) => new Node(tag),
    createDocumentFragment: () => Object.assign(new Node('fragment'), { fragment: true }),
  };
  const listeners = {};
  const calls = [];
  const view = { sessionId: ID, title: null, startedAtUtc: '2026-09-22T10:00:00Z', durationMs: 120000, live: false,
    chip: { kind: 'working', label: 'Transcribing 1/2' }, legacy: false, stage: 'transcribing',
    progress: { label: 'Transcribing 1/2 min', fraction: 0.5 }, banner: { message: 'Sign in to Kern to finish transcribing this call.', action: 'sign-in' },
    note: null, items: [{ kind: 'turn', speaker: 'me', startMs: 1000, endMs: 2000, text: 'Hello there' }, { kind: 'gap', startMs: 60000 },
      { kind: 'turn', speaker: 'them', startMs: 61000, endMs: 62000, text: 'hello back' }],
    partial: true, hasSummary: false, canRename: true, canDelete: true };
  const api = {
    getStatus: async () => ({ state: 'idle', sessionId: null, levels: { me: 0, them: 0 }, failure: null }),
    getSetup: async () => ({ microphone: { mode: 'default' }, transcription: { enabled: true, noticeAcknowledged: false }, build: '1.1.0+abc1234' }),
    listDevices: async () => ({ captureEndpoints: [{ id: 'fifine', name: 'FIFINE K670', supported: true, defaultRoles: ['communications'] }] }),
    listCalls: async () => [{ sessionId: ID, title: null, startedAtUtc: view.startedAtUtc, durationMs: 120000, chip: view.chip, live: false }],
    getCall: async () => view,
    acknowledgeNotice: async () => { calls.push('ack'); return { enabled: true, noticeAcknowledged: true }; },
    start: async () => { calls.push('start'); },
    signIn: async () => { calls.push('sign-in'); },
    ...apiOverrides,
  };
  for (const name of ['onStatus', 'onCallsChanged', 'onOpenCall']) api[name] = (fn) => { listeners[name] = fn; return () => {}; };
  const window = { kernRecorder: api, addEventListener() {}, scrollTo() {} };
  const context = vm.createContext({ window, document, Option: function Option(text, value) { this.text = text; this.value = value; },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Math, Number, String, Promise, Set, Map, Object, Array });
  for (const script of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(UI, script), 'utf8'), context, { filename: script });
  return { el: document.getElementById, listeners, calls, view, document };
}

test('idle: one Start, mic named on one line, the one-time notice before the first recording', async () => {
  const ui = load();
  await settle(); await settle();
  assert.equal(ui.el('start').disabled, false);
  assert.equal(ui.el('mic-name').textContent, 'Windows default (FIFINE K670)');
  assert.equal(ui.el('transcription-state').textContent, 'on');
  assert.equal(ui.el('build').textContent, 'Kern 1.1.0+abc1234');
  ui.el('start').listeners.click();
  assert.equal(ui.el('notice').hidden, false);
  assert.deepEqual(ui.calls, []);
  await ui.el('notice-ok').listeners.click();
  assert.deepEqual(ui.calls, ['ack', 'start']);
  assert.equal(ui.el('calls').children.length, 1);
});

test('recording: timer, You/Them levels, Stop/Mute/Pause, then Stop opens the call view', async () => {
  const ui = load();
  await settle(); await settle();
  const status = { state: 'recording', sessionId: ID, elapsedMs: 754000, levels: { me: 0.5, them: 0 }, micMuted: false, failure: null, warning: null };
  ui.listeners.onStatus(status);
  assert.equal(ui.el('recording').hidden, false);
  assert.equal(ui.el('idle').hidden, true);
  assert.equal(ui.el('timer').textContent, '12:34');
  assert.equal(ui.el('level-me').style.transform, 'scaleX(0.5)');
  assert.equal(ui.el('them-hint').hidden, true);
  ui.listeners.onStatus({ ...status, state: 'paused', pausedBy: 'suspend' });
  assert.equal(ui.el('pause').textContent, 'Resume');
  assert.equal(ui.el('rec-state').textContent, 'Paused while asleep');
  ui.listeners.onStatus({ ...status, state: 'stopped' });
  await settle(); await settle();
  assert.equal(ui.el('call').hidden, false);
  assert.equal(ui.el('call-progress-label').textContent, 'Transcribing 1/2 min');
  assert.equal(ui.el('banner-text').textContent, 'Sign in to Kern to finish transcribing this call.');
  assert.equal(ui.el('banner-action').textContent, 'Sign in');
  await ui.el('banner-action').listeners.click();
  assert.deepEqual(ui.calls, ['sign-in']);
});

test('call view: You/Them turns with timestamps, a gap marker, and Find filters with highlights', async () => {
  const ui = load();
  await settle(); await settle();
  ui.listeners.onOpenCall({ sessionId: ID });
  await settle(); await settle();
  const transcript = ui.el('transcript');
  assert.equal(transcript.children.length, 3);
  assert.equal(transcript.children[0].textContent, 'You00:01Hello there');
  assert.equal(transcript.children[1].textContent, '[a minute of audio could not be transcribed]');
  ui.el('find').value = 'hello';
  ui.el('find').listeners.input();
  assert.equal(transcript.children.length, 2);
  assert.equal(ui.el('find-count').textContent, '2 found');
  assert.equal(transcript.children[1].children[1].children[0].tag, 'mark');
});

test('a start failure shows one sentence with "Choose another mic"', async () => {
  const ui = load();
  await settle(); await settle();
  ui.listeners.onStatus({ state: 'idle', sessionId: null, levels: { me: 0, them: 0 }, failure: { code: 'helper-error', message: 'The microphone is in use.' } });
  assert.equal(ui.el('banner').hidden, false);
  assert.match(ui.el('banner-text').textContent, /could not start\. The microphone is in use\./);
  assert.equal(ui.el('banner-action').textContent, 'Choose another mic');
});
