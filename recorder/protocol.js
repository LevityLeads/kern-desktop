'use strict';

// Renderer <-> main IPC for the local recorder window. Every request channel has a validator
// below; anything the renderer sends that is not listed here is rejected before a handler runs.
const IPC = Object.freeze({
  // main -> renderer events
  STATUS: 'kern-recorder:status',
  CALLS_CHANGED: 'kern-recorder:calls-changed',
  OPEN_CALL: 'kern-recorder:open-call',
  // renderer -> main requests
  GET_STATUS: 'kern-recorder:get-status',
  GET_SETUP: 'kern-recorder:get-setup',
  LIST_DEVICES: 'kern-recorder:list-devices',
  SET_MICROPHONE: 'kern-recorder:set-microphone',
  SET_TRANSCRIPTION: 'kern-recorder:set-transcription',
  ACKNOWLEDGE_NOTICE: 'kern-recorder:acknowledge-notice',
  START: 'kern-recorder:start',
  PAUSE: 'kern-recorder:pause',
  RESUME: 'kern-recorder:resume',
  SET_MIC_MUTED: 'kern-recorder:set-mic-muted',
  STOP: 'kern-recorder:stop',
  LIST_CALLS: 'kern-recorder:list-calls',
  GET_CALL: 'kern-recorder:get-call',
  RENAME_CALL: 'kern-recorder:rename-call',
  RETRY_CALL: 'kern-recorder:retry-call',
  DELETE_CALL: 'kern-recorder:delete-call',
  COPY_TRANSCRIPT: 'kern-recorder:copy-transcript',
  COPY_DIAGNOSTICS: 'kern-recorder:copy-diagnostics',
  OPEN_SUMMARY: 'kern-recorder:open-summary',
  SIGN_IN: 'kern-recorder:sign-in',
});
const EVENT_CHANNELS = Object.freeze([IPC.STATUS, IPC.CALLS_CHANGED, IPC.OPEN_CALL]);

// Helper pipe protocol (native/Kern.Recorder.Helper/Protocol.cs).
const PROTOCOL_VERSION = 2;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ENDPOINT_ID_LENGTH = 1024;
const MAX_TITLE_LENGTH = 120;
// Supervisor states in which a recording exists and must not be abandoned (quit, update, sleep).
const ACTIVE_STATES = new Set(['starting', 'recording', 'paused', 'stopping']);

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
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new TypeError('sessionId is invalid');
  return value.toLowerCase();
}

function assertEndpointId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENDPOINT_ID_LENGTH ||
      /[\0-\x1f\x7f]/u.test(value)) {
    throw new TypeError('microphone.deviceId is invalid');
  }
  return value;
}

function validateMicrophoneSelection(value) {
  const microphone = assertPlainObject(value, 'microphone');
  assertOnlyKeys(microphone, ['mode', 'deviceId'], 'microphone');
  if (microphone.mode !== 'default' && microphone.mode !== 'device') {
    throw new TypeError('microphone.mode must be default or device');
  }
  if (microphone.mode === 'device') return { mode: 'device', deviceId: assertEndpointId(microphone.deviceId) };
  if (microphone.deviceId !== undefined) throw new TypeError('microphone.deviceId is only valid in device mode');
  return { mode: 'default' };
}

// A user-typed call title: one line, no control characters. Empty means "use the date".
function validateTitle(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_TITLE_LENGTH || /[\0-\x1f\x7f]/u.test(value)) {
    throw new TypeError('title is invalid');
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function empty(payload) {
  if (payload === undefined || payload === null) return {};
  assertOnlyKeys(assertPlainObject(payload), []);
  return {};
}

function shaped(payload, keys, read) {
  const value = assertPlainObject(payload);
  assertOnlyKeys(value, keys);
  return read(value);
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
  return value;
}

const session = payload => shaped(payload, ['sessionId'], v => ({ sessionId: assertSessionId(v.sessionId) }));

const VALIDATORS = Object.freeze({
  [IPC.GET_STATUS]: empty,
  [IPC.GET_SETUP]: empty,
  [IPC.LIST_DEVICES]: empty,
  [IPC.SET_MICROPHONE]: validateMicrophoneSelection,
  [IPC.SET_TRANSCRIPTION]: p => shaped(p, ['enabled'], v => ({ enabled: bool(v.enabled, 'enabled') })),
  [IPC.ACKNOWLEDGE_NOTICE]: empty,
  [IPC.START]: empty,
  [IPC.PAUSE]: empty,
  [IPC.RESUME]: empty,
  [IPC.SET_MIC_MUTED]: p => shaped(p, ['muted'], v => ({ muted: bool(v.muted, 'muted') })),
  [IPC.STOP]: empty,
  [IPC.LIST_CALLS]: empty,
  [IPC.GET_CALL]: session,
  [IPC.RENAME_CALL]: p => shaped(p, ['sessionId', 'title'], v => ({
    sessionId: assertSessionId(v.sessionId), title: validateTitle(v.title),
  })),
  [IPC.RETRY_CALL]: session,
  [IPC.DELETE_CALL]: session,
  [IPC.COPY_TRANSCRIPT]: p => shaped(p, ['sessionId', 'format'], v => {
    if (v.format !== 'text' && v.format !== 'markdown') throw new TypeError('format must be text or markdown');
    return { sessionId: assertSessionId(v.sessionId), format: v.format };
  }),
  [IPC.COPY_DIAGNOSTICS]: p => shaped(p, ['sessionId'], v => ({
    sessionId: v.sessionId === null ? null : assertSessionId(v.sessionId),
  })),
  [IPC.OPEN_SUMMARY]: session,
  [IPC.SIGN_IN]: empty,
});
const REQUEST_CHANNELS = Object.freeze(Object.keys(VALIDATORS));

function validateRendererPayload(channel, payload) {
  const validate = VALIDATORS[channel];
  if (!validate) throw new TypeError('Unknown recorder IPC channel');
  return validate(payload);
}

function isActiveState(state) {
  return ACTIVE_STATES.has(state);
}

module.exports = {
  ACTIVE_STATES,
  EVENT_CHANNELS,
  IPC,
  MAX_TITLE_LENGTH,
  PROTOCOL_VERSION,
  REQUEST_CHANNELS,
  SESSION_ID,
  assertEndpointId,
  assertSessionId,
  isActiveState,
  isPlainObject,
  validateMicrophoneSelection,
  validateRendererPayload,
  validateTitle,
};
