'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { CallError, readExactly } = require('./safe-fs');

// Upload windows, per docs/call-api-contract-v2.md: core 60 s, 1 s overlap each side, cut
// straight from audio.pcm (int16 stereo 16 kHz, 4 bytes per frame) behind a 44-byte WAV header.
const FRAMES_PER_MS = 16;
const FRAME_BYTES = 4;
const CORE_MS = 60000;
const OVERLAP_MS = 1000;
const MAX_WINDOWS = 240;
const MAX_DURATION_MS = MAX_WINDOWS * CORE_MS;
const WAV_HEADER_BYTES = 44;

// Window `index` of a call lasting durationMs. Mid-call, durationMs is Infinity: every window
// published during the call is full and keeps exactly this geometry once the call ends.
function windowGeometry(index, durationMs) {
  const coreStartMs = index * CORE_MS;
  const coreEndMs = Math.min(durationMs, coreStartMs + CORE_MS);
  return {
    windowIndex: index,
    startMs: Math.max(0, coreStartMs - OVERLAP_MS),
    endMs: Math.min(durationMs, coreEndMs + OVERLAP_MS),
    coreStartMs,
    coreEndMs,
  };
}

function windowCount(durationMs) {
  return Math.ceil(durationMs / CORE_MS);
}

// How many windows may be published while recording: window i needs committed audio through
// coreStart + 61 s, and must still end inside the 4 h cap (window 239 is always cut at stop).
function liveReadyCount(committedFrames) {
  const committedMs = Math.min(Math.floor(committedFrames / FRAMES_PER_MS), MAX_DURATION_MS);
  const fullMs = CORE_MS + OVERLAP_MS;
  return committedMs < fullMs ? 0 : Math.floor((committedMs - fullMs) / CORE_MS) + 1;
}

// Final call length from the committed frames: rounded down to whole milliseconds (16 frames),
// capped at four hours.
function finalDuration(committedFrames) {
  const durationMs = Math.floor(Math.max(0, committedFrames) / FRAMES_PER_MS);
  return { durationMs: Math.min(durationMs, MAX_DURATION_MS), truncated: durationMs > MAX_DURATION_MS };
}

function wavHeader(frames) {
  const dataBytes = frames * FRAME_BYTES;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                        // PCM
  header.writeUInt16LE(2, 22);                        // channels
  header.writeUInt32LE(16000, 24);                    // sample rate
  header.writeUInt32LE(16000 * FRAME_BYTES, 28);      // byte rate
  header.writeUInt16LE(FRAME_BYTES, 32);              // block align
  header.writeUInt16LE(16, 34);                       // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

// Deterministic object id: the same bytes always register as the same object, so a restart
// mid-upload re-registers the identical window instead of a conflicting one.
function stableId(sessionId, sha256, name) {
  const bytes = crypto.createHash('sha256').update(`${sessionId}\n${sha256}\n${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function windowName(index) {
  return `window-${String(index).padStart(6, '0')}`;
}

function windowObject(sessionId, geometry, sha256, byteLength) {
  const frames = (geometry.endMs - geometry.startMs) * FRAMES_PER_MS;
  return {
    id: stableId(sessionId, sha256, windowName(geometry.windowIndex)),
    kind: 'window',
    sha256,
    byteLength,
    wav: { sampleRate: 16000, channels: 2, bitsPerSample: 16, format: 'pcm', frames },
    ...geometry,
  };
}

// Reads one window from audio.pcm. The caller has already checked committedFrames covers it;
// a shorter file here means the audio was truncated underneath us.
async function cutWindow({ audioFile, sessionId, geometry }) {
  const frames = (geometry.endMs - geometry.startMs) * FRAMES_PER_MS;
  if (!Number.isSafeInteger(frames) || frames <= 0) throw new CallError('invalid-window', 'A window has no audio.');
  const handle = await fs.promises.open(audioFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let pcm;
  try {
    pcm = await readExactly(handle, frames * FRAME_BYTES, geometry.startMs * FRAMES_PER_MS * FRAME_BYTES);
  } finally { await handle.close(); }
  if (pcm.length !== frames * FRAME_BYTES) {
    throw new CallError('audio-truncated', 'The recording file is shorter than expected.');
  }
  const bytes = Buffer.concat([wavHeader(frames), pcm]);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { bytes, object: windowObject(sessionId, geometry, sha256, bytes.length) };
}

module.exports = {
  CORE_MS, FRAMES_PER_MS, MAX_DURATION_MS, MAX_WINDOWS, OVERLAP_MS, WAV_HEADER_BYTES,
  cutWindow, finalDuration, liveReadyCount, stableId, wavHeader, windowCount, windowGeometry, windowObject,
};
