'use strict';

const { isPlainObject } = require('./protocol');

// Protocol-2 status (Models.cs RecorderStatus), sent as a `status` event every 500 ms while a
// session is active and as the result of every command. It comes from our own helper, but it
// crosses a process boundary, so it is checked field by field before anything reads it.
const HELPER_STATES = new Set(['idle', 'recording', 'paused', 'stopped', 'interrupted']);
// States in which the helper holds a running session.
const LIVE_STATES = new Set(['recording', 'paused']);
const SILENT_LEVELS = Object.freeze({ me: 0, them: 0 });
const PLAYBACK_MODES = new Set(['all-apps', 'devices']);
const SOURCE_ID = /^(?:microphone|playback|playback-[0-9a-f]{12})$/;
const SOURCE_MODES = new Set(['microphone', 'process-loopback', 'endpoint-loopback']);
const SOURCE_STATES = new Set(['active', 'idle', 'recovering', 'failed']);
const FAILURE_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value, max) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeSource(source) {
  if (!isPlainObject(source) || !SOURCE_ID.test(source.id) || (source.lane !== 'me' && source.lane !== 'them') ||
      !SOURCE_MODES.has(source.mode) || !SOURCE_STATES.has(source.state)) return null;
  const level = Number.isFinite(source.level) ? Math.min(1, Math.max(0, source.level)) : 0;
  return {
    id: source.id, lane: source.lane, mode: source.mode, state: source.state, level,
    name: text(source.name, 200) || source.id,
    message: text(source.message, 300),
  };
}

function normalizeFailure(failure) {
  if (failure === null || failure === undefined) return null;
  if (!isPlainObject(failure)) return { code: 'capture-error', message: 'Recording stopped unexpectedly.' };
  return {
    code: FAILURE_CODE.test(failure.code) ? failure.code : 'capture-error',
    message: text(failure.message, 500) || 'Recording stopped unexpectedly.',
  };
}

// Returns the normalized status, or null when the payload is not a protocol-2 status at all.
function normalizeHelperStatus(payload) {
  if (!isPlainObject(payload) || !HELPER_STATES.has(payload.state)) return null;
  const sessionId = payload.sessionId === null || payload.sessionId === undefined ? null
    : (typeof payload.sessionId === 'string' && UUID.test(payload.sessionId) ? payload.sessionId.toLowerCase() : undefined);
  if (sessionId === undefined) return null;
  const sources = Array.isArray(payload.sources) ? payload.sources.slice(0, 64).map(normalizeSource).filter(Boolean) : [];
  const level = lane => sources.filter(source => source.lane === lane).reduce((peak, source) => Math.max(peak, source.level), 0);
  return {
    state: payload.state,
    sessionId,
    startedAtUtc: text(payload.startedAtUtc, 64),
    elapsedMs: count(payload.elapsedMs) ?? 0,
    committedFrames: count(payload.committedFrames) ?? 0,
    micMuted: payload.micMuted === true,
    playbackMode: PLAYBACK_MODES.has(payload.playbackMode) ? payload.playbackMode : null,
    levels: { me: level('me'), them: level('them') },
    sources,
    failure: normalizeFailure(payload.failure),
    warning: text(payload.warning, 300),
  };
}

module.exports = { HELPER_STATES, LIVE_STATES, SILENT_LEVELS, normalizeHelperStatus };
