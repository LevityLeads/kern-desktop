'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { IPC, validateRendererPayload } = require('../recorder/protocol');
const { REQUEST_CHANNELS, registerRecorderIpc } = require('../recorder/ipc');
const SESSION_ID = '9b918241-3cb0-447c-8861-8f14358563e7';
const URL = 'file:///app/recorder-ui/index.html';
function fixture() {
  const callbacks = new Map();
  const calls = [];
  const supervisor = new EventEmitter();
  for (const name of ['snapshot', 'listDevices', 'start', 'pause', 'resume', 'setMicMuted', 'stop', 'recover']) {
    supervisor[name] = (...args) => { calls.push({ name, args }); return { ok: true }; };
  }
  const handlers = Object.fromEntries(['listSessions', 'getSession', 'getPlaybackUrl', 'exportSession',
    'showInFolder', 'getCall', 'prepareCall', 'transcribe', 'exportTranscript', 'copyTranscript',
    'getTranscriptionEnabled', 'setTranscriptionEnabled', 'signIn'].map(name => [name, (...args) => {
    calls.push({ name, args }); return { ok: true };
  }]));
  const frame = { url: URL };
  let currentUrl = URL;
  const contents = { mainFrame: frame, getURL: () => currentUrl, isDestroyed: () => false, send() {} };
  const window = { webContents: contents, isDestroyed: () => false };
  const dispose = registerRecorderIpc({
    ipcMain: { handle: (key, fn) => callbacks.set(key, fn), removeHandler: key => callbacks.delete(key) },
    getRecorderWindow: () => window, supervisor, handlers, trustedRecorderUrl: URL,
  });
  return { callbacks, calls, dispose, supervisor, contents, frame,
    event: { sender: contents, senderFrame: frame }, setUrl: url => { currentUrl = url; frame.url = url; } };
}
const sessionChannels = [IPC.GET_CALL, IPC.PREPARE_CALL, IPC.TRANSCRIBE, IPC.EXPORT_TRANSCRIPT, IPC.COPY_TRANSCRIPT];
for (const channel of sessionChannels) {
  test(`${channel} permits only a UUID sessionId`, () => {
    assert.deepEqual(validateRendererPayload(channel, { sessionId: SESSION_ID }), { sessionId: SESSION_ID });
    for (const bad of [undefined, null, [], 'anything', {}, { sessionId: '../escape' },
      { sessionId: SESSION_ID, path: 'C:\\private.wav' }, { sessionId: SESSION_ID, url: 'https://example.org' },
      { sessionId: SESSION_ID, text: 'injected transcript' }, { sessionId: SESSION_ID, consent: true }]) {
      assert.throws(() => validateRendererPayload(channel, bad));
    }
  });
}
test('transcription setting requires boolean and rejects extra keys', () => {
  for (const enabled of [true, false]) assert.deepEqual(validateRendererPayload(IPC.SET_TRANSCRIPTION_ENABLED, { enabled }), { enabled });
  for (const bad of [null, {}, [], { enabled: 1 }, { enabled: 'true' }, { enabled: null }, { enabled: false, autoUploadOldCalls: true }]) {
    assert.throws(() => validateRendererPayload(IPC.SET_TRANSCRIPTION_ENABLED, bad));
  }
  for (const channel of [IPC.GET_TRANSCRIPTION_ENABLED, IPC.SIGN_IN, IPC.GET_STATUS]) {
    assert.deepEqual(validateRendererPayload(channel, undefined), {});
    assert.throws(() => validateRendererPayload(channel, { url: 'file:///elsewhere' }));
  }
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
    f.setUrl('file:///app/other.html');
    await assert.rejects(invoke(f.event), /not trusted/);
    f.setUrl(URL);
  }
  assert.equal(f.calls.length, 0);
  f.dispose();
});
test('payload validation precedes privileged handlers', async () => {
  const f = fixture();
  for (const channel of sessionChannels) await assert.rejects(f.callbacks.get(channel)(f.event, { sessionId: SESSION_ID, path: '/tmp/audio.wav' }));
  assert.equal(f.calls.length, 0);
  await f.callbacks.get(IPC.COPY_TRANSCRIPT)(f.event, { sessionId: SESSION_ID });
  assert.deepEqual(f.calls, [{ name: 'copyTranscript', args: [SESSION_ID] }]);
  f.dispose();
});
test('snapshot and preference reads do not enqueue jobs', async () => {
  const f = fixture();
  await f.callbacks.get(IPC.GET_STATUS)(f.event);
  await f.callbacks.get(IPC.GET_TRANSCRIPTION_ENABLED)(f.event);
  await f.callbacks.get(IPC.SET_TRANSCRIPTION_ENABLED)(f.event, { enabled: true });
  assert.deepEqual(f.calls.map(call => call.name), ['snapshot', 'getTranscriptionEnabled', 'setTranscriptionEnabled']);
  assert.equal(f.supervisor.listenerCount('status'), 1);
  f.dispose();
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.supervisor.listenerCount('status'), 0);
});
