'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempRoot } = require('./helpers');
const { CallSettings } = require('../recorder/call-settings');
const { validateRendererPayload, IPC } = require('../recorder/protocol');

test('callPrompt defaults to on, including for a settings file written before it existed', async (t) => {
  const file = path.join(tempRoot(t), 'call-settings.json');
  assert.equal(new CallSettings(file).get().callPrompt, true);
  fs.writeFileSync(file, JSON.stringify({ version: 2, enabled: false, noticeAcknowledged: true }));
  assert.deepEqual(new CallSettings(file).get(), { enabled: false, noticeAcknowledged: true, callPrompt: true });
});

test('callPrompt persists and does not disturb the other settings', async (t) => {
  const file = path.join(tempRoot(t), 'call-settings.json');
  const settings = new CallSettings(file);
  await settings.acknowledgeNotice();
  await settings.setCallPrompt(false);
  assert.deepEqual(new CallSettings(file).get(), { enabled: true, noticeAcknowledged: true, callPrompt: false });
  await settings.setEnabled(false);
  assert.equal(new CallSettings(file).get().callPrompt, false);
  assert.throws(() => settings.setCallPrompt('yes'), TypeError);
});

test('the set-call-prompt IPC accepts only a boolean', () => {
  assert.deepEqual(validateRendererPayload(IPC.SET_CALL_PROMPT, { enabled: false }), { enabled: false });
  assert.throws(() => validateRendererPayload(IPC.SET_CALL_PROMPT, { enabled: 'no' }), TypeError);
  assert.throws(() => validateRendererPayload(IPC.SET_CALL_PROMPT, { enabled: true, extra: 1 }), TypeError);
});
