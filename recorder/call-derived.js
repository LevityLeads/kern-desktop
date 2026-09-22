'use strict';

const crypto = require('node:crypto');
const { hashFile, jsonFile, sourceManifest, invalid, fail, HASH, MAX_JSON, MAX_PLAYBACK } = require('./call-files');

const RATE = 16000;
// Rendered audio is stereo by construction: channel 0 is every microphone track (Rees), channel 1 is
// every playback endpoint (the other side). The transcriber labels speakers from this split.
const CHANNELS = 2;
const CHANNEL_ROLES = ['microphone', 'playback'];
const FRAME_BYTES = CHANNELS * 2;
const RENDERER_VERSION = 'kern-call-render-2';
const CORE = 60 * RATE;
const OVERLAP = RATE;
const MAX_SAMPLES = 12 * 3600 * RATE;
// Cloud transcription caps a call at two hours, so a live render never needs more.
const MAX_LIVE_WINDOWS = 120;
const LIVE_MANIFEST = 'derived/live-manifest.json';

function stableId(sessionId, fingerprint, relativePath) {
  const bytes = crypto.createHash('sha256').update(`${sessionId}\n${fingerprint}\n${relativePath}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function windowName(index) { return `window-${String(index).padStart(6, '0')}`; }
// Window i of a call with sampleCount samples. A live render passes Infinity: only full cores exist there.
function windowGeometry(index, sampleCount) {
  const coreStart = index * CORE, coreEnd = Math.min(sampleCount, coreStart + CORE);
  const start = Math.max(0, coreStart - OVERLAP), end = Math.min(sampleCount, coreEnd + OVERLAP);
  return { coreStart, coreEnd, start, end };
}
function checkWindow(w, index, sampleCount) {
  const { coreStart, coreEnd, start, end } = windowGeometry(index, sampleCount);
  if (!w || typeof w !== 'object' || w.windowId !== windowName(index) || w.relativePath !== `derived/${windowName(index)}.wav`) invalid('window-identity');
  if (w.startSample !== start || w.endSample !== end || w.coreStartSample !== coreStart || w.coreEndSample !== coreEnd) invalid('window-geometry');
  if (w.byteLength !== 44 + (end - start) * FRAME_BYTES || typeof w.sha256 !== 'string' || !HASH.test(w.sha256)) invalid('window-artifact');
}
function checkFormat(m, reason) {
  if (m.sampleRate !== RATE || m.channels !== CHANNELS || m.bitsPerSample !== 16 ||
      !Array.isArray(m.channelRoles) || m.channelRoles.length !== CHANNEL_ROLES.length ||
      m.channelRoles.some((role, i) => role !== CHANNEL_ROLES[i])) invalid(reason);
}
// Each check has its own reason so a failure names the field, not the file.
function checkDerivedManifest(derived, id, source) {
  if (!derived || typeof derived !== 'object') invalid('derived-manifest-shape');
  if (derived.version !== 1 || derived.rendererVersion !== RENDERER_VERSION) invalid('derived-renderer-version');
  if (!derived.complete) invalid('derived-incomplete');
  if (derived.sessionId !== id) invalid('derived-session');
  if (derived.sourceFingerprint !== source.fingerprint) invalid('derived-source-fingerprint');
  checkFormat(derived, 'derived-format');
  if (!Number.isSafeInteger(derived.sampleCount) || derived.sampleCount < 1) invalid('derived-sample-count');
  if (derived.sampleCount > MAX_SAMPLES) invalid('derived-over-ceiling');
  if (derived.sourceIntegrity !== 'verified') invalid('derived-source-integrity');
  if (derived.audio?.relativePath !== 'derived/call.wav' || derived.audio.byteLength !== 44 + derived.sampleCount * FRAME_BYTES) invalid('derived-audio-shape');
  if (derived.durationSeconds !== derived.sampleCount / RATE) invalid('derived-duration');
  if (!Array.isArray(derived.windows)) invalid('derived-windows-shape');
  if (!Array.isArray(derived.warnings) || derived.warnings.some(w => typeof w !== 'string' || w.length > 2000)) invalid('derived-warnings-shape');
}
async function validateDerived(dir, id, { playbackOnly = false, signal } = {}) {
  const source = await sourceManifest(dir, id, signal);
  const derived = await jsonFile(dir, 'derived/manifest.json');
  checkDerivedManifest(derived, id, source);
  const playbackFile = (await hashFile(dir, derived.audio.relativePath, derived.audio, signal, MAX_PLAYBACK)).file;
  if (playbackOnly) return { ...source, derived, playbackFile };
  if (derived.sampleCount % 16) invalid('derived-sample-grid');
  if (derived.windows.length !== Math.ceil(derived.sampleCount / CORE)) invalid('derived-window-count');
  for (let i = 0; i < derived.windows.length; i += 1) {
    checkWindow(derived.windows[i], i, derived.sampleCount);
    await hashFile(dir, derived.windows[i].relativePath, derived.windows[i], signal);
  }
  return { ...source, derived, playbackFile };
}
// The mid-call renderer publishes only complete windows, with the same names, geometry and bytes
// the final render produces later. Its manifest is untrusted input like every other helper output.
async function validateLiveManifest(dir, id) {
  const live = await jsonFile(dir, LIVE_MANIFEST, MAX_JSON);
  if (!live || live.version !== 1 || live.rendererVersion !== RENDERER_VERSION || live.complete !== false ||
      live.sessionId !== id) invalid('live-manifest-header');
  checkFormat(live, 'live-manifest-header');
  if (!Number.isSafeInteger(live.throughSamples) || live.throughSamples < 0 || live.throughSamples > MAX_SAMPLES ||
      !Array.isArray(live.windows) || live.windows.length > MAX_LIVE_WINDOWS ||
      live.windows.length * CORE > live.throughSamples) invalid('live-manifest-windows');
  for (let i = 0; i < live.windows.length; i += 1) checkWindow(live.windows[i], i, Infinity);
  return live;
}
// One shape for a window object whether it is registered mid-call or sealed after the call.
// The id derives from the bytes, never from the source fingerprint, which only exists once capture stops.
function windowObject(sessionId, w, index) {
  const sha256 = w.sha256.toLowerCase();
  return {
    id: stableId(sessionId, sha256, w.relativePath), kind: 'window', sha256, byteLength: w.byteLength,
    wav: { sampleRate: RATE, channels: CHANNELS, bitsPerSample: 16, format: 'pcm', frames: w.endSample - w.startSample },
    windowIndex: index, startMs: w.startSample / 16, endMs: w.endSample / 16,
    coreStartMs: w.coreStartSample / 16, coreEndMs: w.coreEndSample / 16,
  };
}
// Only the rendered windows go to the cloud. The 5 s capture checkpoints are a local crash log and
// the transcript is the product, so original audio is never uploaded and is discarded after transcription.
async function uploadInventory(dir, id, validated, signal) {
  const { derived } = validated;
  const durationMs = derived.sampleCount / 16;
  if (durationMs > 7200000) fail('too-long', 'Cloud transcription currently supports calls up to two hours. Local audio is safe.', 'call-over-two-hours');
  if (!Array.isArray(derived.windows) || derived.windows.length < 1) invalid('derived-windows-shape');
  const files = [];
  for (let i = 0; i < derived.windows.length; i += 1) {
    signal?.throwIfAborted();
    files.push({ relativePath: derived.windows[i].relativePath, object: windowObject(id, derived.windows[i], i) });
  }
  if (files.length > 8192 || files.reduce((n, f) => n + f.object.byteLength, 0) > 4294967296) fail('size', 'Recording inventory exceeds the cloud limit.', 'inventory-over-limit');
  const sealed = { version: 1, sessionId: id.toLowerCase(), durationMs, objects: files.map(f => f.object) };
  if (Buffer.byteLength(JSON.stringify(sealed)) > 4 * 1024 * 1024) fail('size', 'Recording inventory exceeds the cloud limit.', 'inventory-json-over-limit');
  return { sealed, files };
}
module.exports = { validateDerived, validateLiveManifest, uploadInventory, windowObject, stableId,
  MAX_LIVE_WINDOWS, RENDERER_VERSION, CHANNELS, CHANNEL_ROLES, FRAME_BYTES };
