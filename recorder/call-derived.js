'use strict';

const crypto = require('node:crypto');
const { hashFile, jsonFile, sourceManifest, fail, MAX_UPLOAD, MAX_PLAYBACK } = require('./call-files');

function stableId(sessionId, fingerprint, relativePath) {
  const bytes = crypto.createHash('sha256').update(`${sessionId}\n${fingerprint}\n${relativePath}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function validateDerived(dir, id, { playbackOnly = false, signal } = {}) {
  const source = await sourceManifest(dir, id, signal);
  const derived = await jsonFile(dir, 'derived/manifest.json');
  if (derived.version !== 1 || derived.rendererVersion !== 'kern-call-render-1' || !derived.complete ||
      derived.sessionId !== id || derived.sourceFingerprint !== source.fingerprint ||
      derived.sampleRate !== 16000 || derived.channels !== 1 || derived.bitsPerSample !== 16 ||
      !Number.isSafeInteger(derived.sampleCount) || derived.sampleCount < 1 ||
      derived.sampleCount > 12 * 3600 * 16000 || derived.sourceIntegrity !== 'verified' ||
      derived.audio?.relativePath !== 'derived/call.wav' || derived.audio.byteLength !== 44 + derived.sampleCount * 2 ||
      derived.durationSeconds !== derived.sampleCount / 16000 || !Array.isArray(derived.windows) ||
      !Array.isArray(derived.warnings) || derived.warnings.some(w => typeof w !== 'string' || w.length > 2000)) fail();
  const playbackFile = (await hashFile(dir, derived.audio.relativePath, derived.audio, signal, MAX_PLAYBACK)).file;
  if (playbackOnly) return { ...source, derived, playbackFile };
  if (derived.sampleCount % 16 || derived.windows.length !== Math.ceil(derived.sampleCount / 960000)) fail();
  for (let i = 0; i < derived.windows.length; i += 1) {
    const w = derived.windows[i];
    const coreStart = i * 960000, coreEnd = Math.min(derived.sampleCount, coreStart + 960000);
    const start = Math.max(0, coreStart - 16000), end = Math.min(derived.sampleCount, coreEnd + 16000);
    if (w.windowId !== `window-${String(i).padStart(6, '0')}` ||
        w.relativePath !== `derived/window-${String(i).padStart(6, '0')}.wav` ||
        w.startSample !== start || w.endSample !== end || w.coreStartSample !== coreStart || w.coreEndSample !== coreEnd ||
        w.byteLength !== 44 + (end - start) * 2) fail();
    await hashFile(dir, w.relativePath, w, signal);
  }
  return { ...source, derived, playbackFile };
}
function wavFormat(track, segment) {
  const f = track?.format;
  if (!f || !Number.isInteger(f.sampleRate) || f.sampleRate < 8000 || f.sampleRate > 192000 ||
      !Number.isInteger(f.channels) || f.channels < 1 || f.channels > 8 || !Number.isSafeInteger(segment.sampleCount)) fail();
  const encoding = new Map([['pcm', 'pcm'], ['Pcm', 'pcm'], ['ieeefloat', 'ieeefloat'],
    ['IeeeFloat', 'ieeefloat'], ['extensible', 'extensible'], ['Extensible', 'extensible']]).get(f.encoding);
  let format;
  if (encoding === 'pcm' || (encoding === 'extensible' && String(f.subFormat).toLowerCase() === '00000001-0000-0010-8000-00aa00389b71')) format = 'pcm';
  if (encoding === 'ieeefloat' || (encoding === 'extensible' && String(f.subFormat).toLowerCase() === '00000003-0000-0010-8000-00aa00389b71')) format = 'float';
  if (!format || (format === 'float' ? f.bitsPerSample !== 32 : ![8, 16, 24, 32].includes(f.bitsPerSample))) fail();
  return { sampleRate: f.sampleRate, channels: f.channels, bitsPerSample: f.bitsPerSample, format, frames: segment.sampleCount };
}
async function uploadInventory(dir, id, validated, signal) {
  const { manifest, fingerprint, derived } = validated;
  const durationMs = derived.sampleCount / 16;
  if (durationMs > 7200000) fail('too-long', 'Cloud transcription currently supports calls up to two hours. Local audio is safe.');
  if (!Array.isArray(manifest.segments) || !Array.isArray(manifest.tracks)) fail();
  const files = [];
  for (const segment of manifest.segments) {
    if (segment.status !== 'finalised') continue;
    if (segment.byteLength > MAX_UPLOAD || segment.byteLength < 44) fail('size', 'An original checkpoint exceeds the cloud upload limit.');
    await hashFile(dir, segment.relativePath, segment, signal);
    files.push({ relativePath: segment.relativePath, object: {
      id: stableId(id, fingerprint, segment.relativePath), kind: 'original', sha256: segment.sha256.toLowerCase(),
      byteLength: segment.byteLength, wav: wavFormat(manifest.tracks.find(t => t.trackId === segment.trackId), segment),
    } });
  }
  for (let i = 0; i < derived.windows.length; i += 1) {
    const w = derived.windows[i];
    files.push({ relativePath: w.relativePath, object: {
      id: stableId(id, fingerprint, w.relativePath), kind: 'window', sha256: w.sha256.toLowerCase(), byteLength: w.byteLength,
      wav: { sampleRate: 16000, channels: 1, bitsPerSample: 16, format: 'pcm', frames: w.endSample - w.startSample },
      windowIndex: i, startMs: w.startSample / 16, endMs: w.endSample / 16,
      coreStartMs: w.coreStartSample / 16, coreEndMs: w.coreEndSample / 16,
    } });
  }
  if (files.length > 8192 || !files.some(f => f.object.kind === 'original') ||
      files.reduce((n, f) => n + f.object.byteLength, 0) > 4294967296) fail('size', 'Recording inventory exceeds the cloud limit.');
  const sealed = { version: 1, sessionId: id.toLowerCase(), durationMs, objects: files.map(f => f.object) };
  if (Buffer.byteLength(JSON.stringify(sealed)) > 4 * 1024 * 1024) fail('size', 'Recording inventory exceeds the cloud limit.');
  return { sealed, files };
}
module.exports = { validateDerived, uploadInventory, stableId };
