'use strict';

const IPC = Object.freeze({
  STATUS: 'kern-recorder:status',
  GET_STATUS: 'kern-recorder:get-status',
  GET_MICROPHONE: 'kern-recorder:get-microphone',
  SET_MICROPHONE: 'kern-recorder:set-microphone',
  GET_CALL: 'kern-recorder:get-call',
  PREPARE_CALL: 'kern-recorder:prepare-call',
  TRANSCRIBE: 'kern-recorder:transcribe',
  EXPORT_TRANSCRIPT: 'kern-recorder:export-transcript',
  COPY_TRANSCRIPT: 'kern-recorder:copy-transcript',
  GET_TRANSCRIPTION_ENABLED: 'kern-recorder:get-transcription-enabled',
  SET_TRANSCRIPTION_ENABLED: 'kern-recorder:set-transcription-enabled',
  SIGN_IN: 'kern-recorder:sign-in',
  LIST_DEVICES: 'kern-recorder:list-devices',
  LIST_SESSIONS: 'kern-recorder:list-sessions',
  GET_SESSION: 'kern-recorder:get-session',
  START: 'kern-recorder:start',
  PAUSE: 'kern-recorder:pause',
  RESUME: 'kern-recorder:resume',
  SET_MIC_MUTED: 'kern-recorder:set-mic-muted',
  STOP: 'kern-recorder:stop',
  RECOVER: 'kern-recorder:recover',
  GET_PLAYBACK_URL: 'kern-recorder:get-playback-url',
  EXPORT: 'kern-recorder:export',
  SHOW_IN_FOLDER: 'kern-recorder:show-in-folder',
});

const PROTOCOL_VERSION = 1;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_ENDPOINT_ID_LENGTH = 1024;
const ACTIVE_STATES = new Set([
  'starting',
  'recording',
  'pausing',
  'paused',
  'muting',
  'unmuting',
  'resuming',
  'stopping',
  'degraded',
  'suspended',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label = 'payload') {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function assertOnlyKeys(value, allowed, label = 'payload') {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label}.${key} is not allowed`);
  }
}

function assertSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw new TypeError('sessionId is invalid');
  }
  return value;
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertEndpointId(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ENDPOINT_ID_LENGTH ||
    /[\0-\x1f\x7f]/u.test(value)
  ) {
    throw new TypeError('microphone.deviceId is invalid');
  }
  return value;
}

function validateStartPayload(payload) {
  const value = assertPlainObject(payload);
  assertOnlyKeys(value, ['microphone', 'consentAcknowledged']);
  if (value.consentAcknowledged !== true) {
    throw new TypeError('Recording consent reminder must be acknowledged');
  }

  return { consentAcknowledged: true, microphone: validateMicrophoneSelection(value.microphone) };
}

function validateMicrophoneSelection(value) {
  const microphone = assertPlainObject(value, 'microphone');
  assertOnlyKeys(microphone, ['mode', 'deviceId'], 'microphone');
  if (microphone.mode !== 'default' && microphone.mode !== 'device') {
    throw new TypeError('microphone.mode must be default or device');
  }
  if (microphone.mode === 'device') assertEndpointId(microphone.deviceId);
  if (microphone.mode === 'default' && microphone.deviceId !== undefined) {
    throw new TypeError('microphone.deviceId is only valid in device mode');
  }

  return microphone.mode === 'device'
    ? { mode: 'device', deviceId: microphone.deviceId }
    : { mode: 'default' };
}

function validateMicMutePayload(payload) {
  const value = assertPlainObject(payload);
  assertOnlyKeys(value, ['muted']);
  if (typeof value.muted !== 'boolean') throw new TypeError('muted must be boolean');
  return { muted: value.muted };
}

function validateSessionPayload(payload) {
  const value = assertPlainObject(payload);
  assertOnlyKeys(value, ['sessionId']);
  return { sessionId: assertSessionId(value.sessionId) };
}

function validatePlaybackPayload(payload) {
  const value = assertPlainObject(payload);
  assertOnlyKeys(value, ['sessionId', 'trackId', 'segmentId']);
  return {
    sessionId: assertSessionId(value.sessionId),
    trackId: assertSafeId(value.trackId, 'trackId'),
    segmentId: assertSafeId(value.segmentId, 'segmentId'),
  };
}

function validateEmptyPayload(payload) {
  if (payload === undefined || payload === null) return {};
  const value = assertPlainObject(payload);
  assertOnlyKeys(value, []);
  return {};
}

function validateRendererPayload(channel, payload) {
  switch (channel) {
    case IPC.START:
      return validateStartPayload(payload);
    case IPC.SET_MICROPHONE:
      return validateMicrophoneSelection(payload);
    case IPC.SET_MIC_MUTED:
      return validateMicMutePayload(payload);
    case IPC.SET_TRANSCRIPTION_ENABLED: {
      const value = assertPlainObject(payload);
      assertOnlyKeys(value, ['enabled']);
      if (typeof value.enabled !== 'boolean') throw new TypeError('enabled must be boolean');
      return { enabled: value.enabled };
    }
    case IPC.GET_CALL:
    case IPC.PREPARE_CALL:
    case IPC.TRANSCRIBE:
    case IPC.EXPORT_TRANSCRIPT:
    case IPC.COPY_TRANSCRIPT:
    case IPC.GET_SESSION:
    case IPC.RECOVER:
    case IPC.EXPORT:
    case IPC.SHOW_IN_FOLDER:
      return validateSessionPayload(payload);
    case IPC.GET_PLAYBACK_URL:
      return validatePlaybackPayload(payload);
    case IPC.GET_MICROPHONE:
    case IPC.GET_STATUS:
    case IPC.GET_TRANSCRIPTION_ENABLED:
    case IPC.SIGN_IN:
    case IPC.LIST_DEVICES:
    case IPC.LIST_SESSIONS:
    case IPC.PAUSE:
    case IPC.RESUME:
    case IPC.STOP:
      return validateEmptyPayload(payload);
    default:
      throw new TypeError('Unknown recorder IPC channel');
  }
}

function isActiveState(state) {
  return ACTIVE_STATES.has(state);
}

module.exports = {
  ACTIVE_STATES,
  IPC,
  PROTOCOL_VERSION,
  assertEndpointId,
  assertSafeId,
  assertSessionId,
  isActiveState,
  isPlainObject,
  validateRendererPayload,
  validateMicrophoneSelection,
};
