'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MicrophonePreference } = require('../recorder/microphone-preference');
const { IPC, validateRendererPayload } = require('../recorder/protocol');

test('microphone preference persists explicit endpoint and explicit default across instances', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-mic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const store = new MicrophonePreference(file);
  assert.deepEqual(store.get(), { mode: 'default' });
  const selected = { mode: 'device', deviceId: '{fifine-endpoint}' };
  store.set(selected);
  assert.deepEqual(new MicrophonePreference(file).get(), selected);
  store.set({ mode: 'default' });
  assert.deepEqual(new MicrophonePreference(file).get(), { mode: 'default' });
  fs.writeFileSync(file, '{broken');
  assert.throws(() => store.get(), /could not be read/);
  fs.writeFileSync(file, JSON.stringify({version:1,microphone:{mode:'device',deviceId:''}}));
  assert.throws(() => store.get(), /could not be read/);
  const failed = new MicrophonePreference(path.join(dir, 'absent', 'settings.json'));
  assert.throws(() => failed.set(selected), /could not be saved/);
});

test('microphone preference IPC uses the same strict selection validation the helper start uses', () => {
  assert.deepEqual(validateRendererPayload(IPC.GET_SETUP), {});
  assert.deepEqual(validateRendererPayload(IPC.SET_MICROPHONE, { mode:'device', deviceId:'fifine' }), { mode:'device', deviceId:'fifine' });
  for (const payload of [{mode:'selected'}, {mode:'default',deviceId:'airpods'}, {mode:'device',deviceId:'bad\0'}, {mode:'default',extra:true}]) {
    assert.throws(() => validateRendererPayload(IPC.SET_MICROPHONE, payload));
  }
});
