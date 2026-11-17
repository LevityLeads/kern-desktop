'use strict';

const { writeJsonWithRetry } = require('./atomic-json');
const { isPlainObject } = require('./protocol');
const { CallError, safePath, readJsonFile } = require('./safe-fs');
const { FILES, sessionDir } = require('./session-catalog');

// call.json: the desktop's durable record of one call's processing. Written atomically after
// every step, validated on every load, so a crash at any point resumes exactly where it stopped.
//
// stage: recording  capture running (windows publish live)
//        local      transcription was off for this call
//        publishing uploading the remaining windows after the call ended
//        transcribing  finalized; waiting for Kern
//        complete   Kern has the transcript (audio deleted); the summary is read in Kern
//        empty      the call ended with no audio
//        sign-in-required | failed
const STAGES = new Set(['recording', 'local', 'publishing', 'transcribing', 'complete', 'empty', 'sign-in-required', 'failed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_CALL_BYTES = 16 * 1024 * 1024;

function fresh(sessionId, { transcribe = false } = {}) {
  return {
    version: 2, sessionId, title: null, transcribe,
    origin: null, ownerId: null, storageOrigin: null, remoteId: null,
    finalFrames: null, truncated: false, endReason: null,
    windows: [], finalized: false,
    cloud: { state: null, windowCount: null, transcribedWindows: null, kernThreadUrl: null },
    cloudFailed: false, summaryNotifiedAt: null, audioDeleted: false,
    stage: transcribe ? 'recording' : 'local', error: null, attempts: 0, nextAttemptAt: 0, completedAt: null,
  };
}

const int = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const nullable = (value, check) => value === null || check(value);
const str = max => value => typeof value === 'string' && value.length <= max;

function validWindow(w, index) {
  return isPlainObject(w) && UUID.test(w.id) && HASH.test(w.sha256) && w.windowIndex === index &&
    int(w.byteLength, 45) && int(w.frames, 1) && int(w.startMs) && int(w.endMs, 1) && int(w.coreStartMs) &&
    int(w.coreEndMs, 1) && w.byteLength === 44 + w.frames * 4 && w.frames === (w.endMs - w.startMs) * 16 &&
    typeof w.registered === 'boolean' && typeof w.uploaded === 'boolean';
}

function validCloud(cloud) {
  return isPlainObject(cloud) && nullable(cloud.state, str(32)) && nullable(cloud.windowCount, int) &&
    nullable(cloud.transcribedWindows, int) && nullable(cloud.kernThreadUrl, str(2048));
}

function validError(error) {
  return error === null || (isPlainObject(error) && CODE.test(error.code) && str(300)(error.message) && typeof error.retry === 'boolean');
}

function validate(value, sessionId) {
  // call.json files written before summaryNotifiedAt existed, and any transcript an older version
  // stored: the transcript is never kept or shown here any more, the next save drops it.
  if (isPlainObject(value)) {
    if (value.summaryNotifiedAt === undefined) value.summaryNotifiedAt = null;
    delete value.transcript;
  }
  const ok = isPlainObject(value) && value.version === 2 && value.sessionId === sessionId &&
    nullable(value.title, str(120)) && typeof value.transcribe === 'boolean' &&
    nullable(value.origin, str(256)) && nullable(value.ownerId, str(128)) && nullable(value.storageOrigin, str(256)) &&
    nullable(value.remoteId, v => UUID.test(v)) && nullable(value.finalFrames, int) &&
    typeof value.truncated === 'boolean' && nullable(value.endReason, v => v === 'stopped' || v === 'interrupted') &&
    Array.isArray(value.windows) && value.windows.length <= 240 && value.windows.every(validWindow) &&
    typeof value.finalized === 'boolean' && validCloud(value.cloud) && typeof value.cloudFailed === 'boolean' && nullable(value.summaryNotifiedAt, str(64)) &&
    typeof value.audioDeleted === 'boolean' && STAGES.has(value.stage) && validError(value.error) &&
    int(value.attempts) && Number.isFinite(value.nextAttemptAt) && nullable(value.completedAt, str(64));
  if (!ok) throw new CallError('invalid-state', 'This call\'s saved progress is damaged.');
  return value;
}

class CallStore {
  constructor(root) { this.root = root; }

  // The saved state, or null when this call has none yet.
  async load(sessionId) {
    const dir = await sessionDir(this.root, sessionId);
    let value;
    try { value = await readJsonFile(dir, FILES.CALL, MAX_CALL_BYTES); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return validate(value, sessionId);
  }

  async save(state) {
    validate(structuredClone(state), state.sessionId);
    const file = await safePath(await sessionDir(this.root, state.sessionId), FILES.CALL, true);
    await writeJsonWithRetry(file, state);
  }
}

module.exports = { CallStore, STAGES, fresh, validate };
