'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IPC, EVENT_CHANNELS, REQUEST_CHANNELS, validateRendererPayload } = require('../recorder/protocol');
const { registerRecorderIpc } = require('../recorder/ipc');

const SESSION_ID = '9b918241-3cb0-447c-8861-8f14358563e7';
const URL = 'file:///app/recorder-ui/index.html';

function fixture() {
  const callbacks = new Map();
  const calls = [];
  const sent = [];
  const handlers = Object.fromEntries(REQUEST_CHANNELS.map((channel) => [channel, (payload) => { calls.push({ channel, payload }); return { ok: true }; }]));
  const frame = { url: URL };
  let currentUrl = URL;
  const contents = { mainFrame: frame, getURL: () => currentUrl, isDestroyed: () => false, send: (...args) => sent.push(args) };
  const window = { webContents: contents, isDestroyed: () => false };
  const ipc = registerRecorderIpc({
    ipcMain: { handle: (key, fn) => callbacks.set(key, fn), removeHandler: (key) => callbacks.delete(key) },
    getRecorderWindow: () => window, handlers, trustedRecorderUrl: URL,
  });
  return { callbacks, calls, sent, ipc, contents, frame,
    event: { sender: contents, senderFrame: frame }, setUrl: (url) => { currentUrl = url; frame.url = url; } };
}

test('the sandboxed preload exposes exactly the channels main validates', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../recorder-ui/preload.js'), 'utf8');
  const listed = [...preload.matchAll(/'(kern-recorder:[a-z-]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, [...REQUEST_CHANNELS, ...EVENT_CHANNELS].sort());
});

test('every IPC rejects remote windows, subframes, missing frames and navigation', async () => {
  const f = fixture();
  for (const channel of REQUEST_CHANNELS) {
    const invoke = f.callbacks.get(channel);
    await assert.rejects(invoke({ sender: {}, senderFrame: f.frame }), /restricted/);
    await assert.rejects(invoke({ sender: f.contents, senderFrame: { url: URL } }), /restricted/);
    await assert.rejects(invoke({ sender: f.contents, senderFrame: null }), /restricted/);
    f.setUrl('https://kern.example.org');
    await assert.rejects(invoke(f.event), /not trusted/);
    f.setUrl(URL);
  }
  assert.equal(f.calls.length, 0);
  f.ipc.dispose();
  assert.equal(f.callbacks.size, 0);
});

test('payload validation runs before any handler', async () => {
  const f = fixture();
  await assert.rejects(f.callbacks.get(IPC.GET_CALL)(f.event, { sessionId: SESSION_ID, path: 'C:\\audio.pcm' }));
  await assert.rejects(f.callbacks.get(IPC.START)(f.event, { microphone: { mode: 'default' } }), /not allowed/);
  await assert.rejects(f.callbacks.get(IPC.COPY_TRANSCRIPT)(f.event, { sessionId: SESSION_ID, format: 'html' }));
  assert.equal(f.calls.length, 0);
  await f.callbacks.get(IPC.COPY_TRANSCRIPT)(f.event, { sessionId: SESSION_ID.toUpperCase(), format: 'markdown' });
  assert.deepEqual(f.calls, [{ channel: IPC.COPY_TRANSCRIPT, payload: { sessionId: SESSION_ID, format: 'markdown' } }]);
});

test('session ids, titles and mic selections are strictly shaped', () => {
  for (const channel of [IPC.GET_CALL, IPC.RETRY_CALL, IPC.DELETE_CALL, IPC.OPEN_SUMMARY]) {
    assert.deepEqual(validateRendererPayload(channel, { sessionId: SESSION_ID }), { sessionId: SESSION_ID });
    for (const bad of [undefined, null, [], {}, { sessionId: '../escape' }, { sessionId: SESSION_ID, url: 'https://x' }]) {
      assert.throws(() => validateRendererPayload(channel, bad));
    }
  }
  assert.deepEqual(validateRendererPayload(IPC.RENAME_CALL, { sessionId: SESSION_ID, title: '  Acme intro  ' }), { sessionId: SESSION_ID, title: 'Acme intro' });
  assert.deepEqual(validateRendererPayload(IPC.RENAME_CALL, { sessionId: SESSION_ID, title: '' }), { sessionId: SESSION_ID, title: null });
  assert.throws(() => validateRendererPayload(IPC.RENAME_CALL, { sessionId: SESSION_ID, title: 'a\nb' }));
  assert.throws(() => validateRendererPayload(IPC.RENAME_CALL, { sessionId: SESSION_ID, title: 'x'.repeat(121) }));
  const deviceId = '{0.0.1.00000000}.{33f9f5ba-84c7-4e62-b0ca-94704e95766b}';
  assert.deepEqual(validateRendererPayload(IPC.SET_MICROPHONE, { mode: 'device', deviceId }), { mode: 'device', deviceId });
  assert.throws(() => validateRendererPayload(IPC.SET_MICROPHONE, { mode: 'device', deviceId: 'a\0b' }));
  assert.deepEqual(validateRendererPayload(IPC.COPY_DIAGNOSTICS, { sessionId: null }), { sessionId: null });
  assert.deepEqual(validateRendererPayload(IPC.PAUSE), {});
  assert.throws(() => validateRendererPayload(IPC.PAUSE, { delay: 9999 }), /not allowed/);
  assert.throws(() => validateRendererPayload('kern-recorder:export', {}), /Unknown/);
});

test('events reach only the bundled recorder page', () => {
  const f = fixture();
  f.ipc.send(IPC.STATUS, { state: 'recording' });
  f.setUrl('https://kern.example.org');
  f.ipc.send(IPC.CALLS_CHANGED, {});
  assert.deepEqual(f.sent, [[IPC.STATUS, { state: 'recording' }]]);
  assert.throws(() => f.ipc.send('kern-recorder:anything', {}));
});
