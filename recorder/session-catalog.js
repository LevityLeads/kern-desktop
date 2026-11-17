'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertSessionId, isPlainObject } = require('./protocol');
const { CallError, safePath, readJsonFile, fileSize } = require('./safe-fs');

// <Documents>/Kern Recordings/<uuid>/
//   session.json   written by the helper (capture v2), read-only here
//   audio.pcm      interleaved int16 stereo 16 kHz, append-only, deleted once the transcript is stored
//   call.json      the desktop's own processing state (call-store.js)
// Older v1 recordings have manifest.json (+ processing.json) instead and are listed read-only.
const FILES = Object.freeze({
  SESSION: 'session.json', AUDIO: 'audio.pcm', CALL: 'call.json',
  V1_MANIFEST: 'manifest.json', V1_STATE: 'processing.json',
});
const FRAME_BYTES = 4;
const DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_STATES = new Set(['recording', 'paused', 'stopped', 'interrupted']);
const MAX_SESSION_BYTES = 1024 * 1024;
const MAX_V1_MANIFEST_BYTES = 32 * 1024 * 1024;

function createSessionId() { return crypto.randomUUID(); }

function sessionDirectory(root, sessionId) {
  return path.join(path.resolve(root), assertSessionId(sessionId));
}

async function listSessionIds(root) {
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isDirectory() && DIR_NAME.test(entry.name)).map(entry => entry.name);
}

async function sessionDir(root, sessionId) {
  const dir = await safePath(root, assertSessionId(sessionId));
  if (!(await fs.promises.lstat(dir)).isDirectory()) throw new CallError('invalid-path', 'Recording folder is missing.');
  return dir;
}

function validDate(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validateSession(doc, sessionId) {
  if (!isPlainObject(doc) || doc.format !== 'kern-call-audio/1' || typeof doc.sessionId !== 'string' ||
      doc.sessionId.toLowerCase() !== sessionId || !SESSION_STATES.has(doc.state) || !validDate(doc.startedAtUtc) ||
      !(doc.endedAtUtc === null || validDate(doc.endedAtUtc)) || doc.sampleRate !== 16000 || doc.channels !== 2 ||
      !Number.isSafeInteger(doc.committedFrames) || doc.committedFrames < 0) {
    throw new CallError('invalid-session', 'This recording\'s session.json is damaged.');
  }
  const failure = isPlainObject(doc.failure) && typeof doc.failure.message === 'string'
    ? { code: String(doc.failure.code || 'capture-error').slice(0, 64), message: doc.failure.message.slice(0, 500) } : null;
  return { sessionId, state: doc.state, startedAtUtc: doc.startedAtUtc, endedAtUtc: doc.endedAtUtc,
    committedFrames: doc.committedFrames, failure };
}

// The validated session.json, or null when the helper never wrote one.
async function readSession(root, sessionId) {
  const dir = await sessionDir(root, sessionId);
  let doc;
  try { doc = await readJsonFile(dir, FILES.SESSION, MAX_SESSION_BYTES); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return validateSession(doc, sessionId);
}

// Committed frames on disk: the file length is the authority, not session.json.
async function audioFrames(root, sessionId) {
  const size = await fileSize(await sessionDir(root, sessionId), FILES.AUDIO);
  return size === null ? null : Math.floor(size / FRAME_BYTES);
}

async function audioPath(root, sessionId) {
  return safePath(await sessionDir(root, sessionId), FILES.AUDIO);
}

// A v1 recording: shown in the list (date and length only), never processed.
async function readLegacy(root, sessionId) {
  const dir = await sessionDir(root, sessionId);
  const legacy = { sessionId, startedAtUtc: null, durationMs: 0 };
  try {
    const manifest = await readJsonFile(dir, FILES.V1_MANIFEST, MAX_V1_MANIFEST_BYTES);
    if (!isPlainObject(manifest) || manifest.protocolVersion !== 1 || manifest.sessionId !== sessionId) return legacy;
    if (validDate(manifest.startedAtUtc)) legacy.startedAtUtc = manifest.startedAtUtc;
    if (Number.isSafeInteger(manifest.durationMs) && manifest.durationMs > 0) legacy.durationMs = manifest.durationMs;
  } catch { return legacy; }
  return legacy;
}

// 'v2' (session.json), 'v1' (manifest.json) or 'none' (an empty folder from a start that failed).
async function sessionKind(root, sessionId) {
  const dir = await sessionDir(root, sessionId);
  if ((await fileSize(dir, FILES.SESSION)) !== null) return 'v2';
  if ((await fileSize(dir, FILES.V1_MANIFEST)) !== null) return 'v1';
  if ((await fileSize(dir, FILES.CALL)) !== null || (await fileSize(dir, FILES.AUDIO)) > 0) return 'v2';
  return 'none';
}

async function deleteAudio(root, sessionId) {
  const file = await safePath(await sessionDir(root, sessionId), FILES.AUDIO, true);
  await fs.promises.rm(file, { force: true, maxRetries: 3, retryDelay: 200 });
}

// Removes a whole recording folder. rm does not follow links, and safePath refused them anyway.
async function removeSession(root, sessionId) {
  const dir = await sessionDir(root, sessionId);
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

module.exports = {
  FILES, FRAME_BYTES, audioFrames, audioPath, createSessionId, deleteAudio, listSessionIds, readLegacy,
  readSession, removeSession, sessionDir, sessionDirectory, sessionKind, validateSession,
};
