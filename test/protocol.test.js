'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IPC, validateRendererPayload } = require('../recorder/protocol');

const SESSION_ID = '9b918241-3cb0-447c-8861-8f14358563e7';

test('start payload preserves opaque Windows endpoint IDs', () => {
  const deviceId = '{0.0.1.00000000}.{33f9f5ba-84c7-4e62-b0ca-94704e95766b}';
  assert.deepEqual(validateRendererPayload(IPC.START, {
    microphone: { mode: 'device', deviceId },
    consentAcknowledged: true,
  }), {
    microphone: { mode: 'device', deviceId },
    consentAcknowledged: true,
  });
  assert.throws(() => validateRendererPayload(IPC.START, {
    microphone: { mode: 'device', deviceId: 'endpoint\0injected' },
    consentAcknowledged: true,
  }), /invalid/);
});

test('start rejects extra keys and missing consent', () => {
  assert.throws(() => validateRendererPayload(IPC.START, {
    microphone: { mode: 'default' },
    consentAcknowledged: false,
  }), /consent/i);
  assert.throws(() => validateRendererPayload(IPC.START, {
    microphone: { mode: 'default' },
    consentAcknowledged: true,
    executable: 'cmd.exe',
  }), /not allowed/);
});

test('session and playback identifiers reject path traversal', () => {
  assert.deepEqual(validateRendererPayload(IPC.GET_SESSION, { sessionId: SESSION_ID }), { sessionId: SESSION_ID });
  assert.throws(() => validateRendererPayload(IPC.GET_SESSION, { sessionId: '../../Windows' }), /invalid/);
  assert.throws(() => validateRendererPayload(IPC.GET_PLAYBACK_URL, {
    sessionId: SESSION_ID,
    trackId: '../outside',
    segmentId: 'segment',
  }), /invalid/);
});

test('empty commands reject renderer-supplied arguments', () => {
  assert.deepEqual(validateRendererPayload(IPC.PAUSE), {});
  assert.throws(() => validateRendererPayload(IPC.PAUSE, { delay: 9999 }), /not allowed/);
});
