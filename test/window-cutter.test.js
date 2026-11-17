'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { SESSION, pcmFrames, sha, tempRoot, writeSession } = require('./helpers');
const {
  cutWindow, finalDuration, liveReadyCount, stableId, wavHeader, windowCount, windowGeometry, MAX_DURATION_MS,
} = require('../recorder/window-cutter');

function expectedBytes(startMs, endMs) {
  const frames = (endMs - startMs) * 16;
  return Buffer.concat([wavHeader(frames), pcmFrames(startMs * 16, frames)]);
}

test('canonical WAV header: PCM, 2 channels, 16 kHz, 16 bit', () => {
  const header = wavHeader(1000);
  assert.equal(header.length, 44);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt32LE(4), 36 + 4000);
  assert.equal(header.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.deepEqual([header.readUInt32LE(16), header.readUInt16LE(20), header.readUInt16LE(22)], [16, 1, 2]);
  assert.deepEqual([header.readUInt32LE(24), header.readUInt32LE(28), header.readUInt16LE(32), header.readUInt16LE(34)], [16000, 64000, 4, 16]);
  assert.equal(header.toString('ascii', 36, 40), 'data');
  assert.equal(header.readUInt32LE(40), 4000);
});

test('mid-call: only full windows are ready, with exact bytes and hash', async (t) => {
  const root = tempRoot(t);
  const committed = 150000 * 16;
  writeSession(root, { state: 'recording', frames: committed });
  assert.equal(liveReadyCount(61000 * 16 - 1), 0);
  assert.equal(liveReadyCount(61000 * 16), 1);
  assert.equal(liveReadyCount(committed), 2);
  const audioFile = path.join(root, SESSION, 'audio.pcm');
  const expected = [[0, 61000, 0, 60000], [59000, 121000, 60000, 120000]];
  for (const [index, [startMs, endMs, coreStartMs, coreEndMs]] of expected.entries()) {
    const geometry = windowGeometry(index, Infinity);
    assert.deepEqual(geometry, { windowIndex: index, startMs, endMs, coreStartMs, coreEndMs });
    const { bytes, object } = await cutWindow({ audioFile, sessionId: SESSION, geometry });
    const reference = expectedBytes(startMs, endMs);
    assert.ok(bytes.equals(reference));
    assert.equal(object.sha256, sha(reference));
    assert.equal(object.byteLength, 44 + (endMs - startMs) * 16 * 4);
    assert.deepEqual(object.wav, { sampleRate: 16000, channels: 2, bitsPerSample: 16, format: 'pcm', frames: (endMs - startMs) * 16 });
    assert.equal(object.id, stableId(SESSION, object.sha256, `window-${String(index).padStart(6, '0')}`));
    assert.equal(object.kind, 'window');
  }
});

test('after stop: the contract example of 120500 ms gives short last two windows', async (t) => {
  const root = tempRoot(t);
  // 7 stray frames and a torn half-frame past the last whole millisecond are rounded away.
  const frames = 120500 * 16 + 7;
  writeSession(root, { frames, extraBytes: 2 });
  const { durationMs, truncated } = finalDuration(Math.floor((frames * 4 + 2) / 4));
  assert.deepEqual({ durationMs, truncated }, { durationMs: 120500, truncated: false });
  assert.equal(windowCount(durationMs), 3);
  const expected = [
    { windowIndex: 0, startMs: 0, endMs: 61000, coreStartMs: 0, coreEndMs: 60000 },
    { windowIndex: 1, startMs: 59000, endMs: 120500, coreStartMs: 60000, coreEndMs: 120000 },
    { windowIndex: 2, startMs: 119000, endMs: 120500, coreStartMs: 120000, coreEndMs: 120500 },
  ];
  const audioFile = path.join(root, SESSION, 'audio.pcm');
  for (const geometry of expected) {
    assert.deepEqual(windowGeometry(geometry.windowIndex, durationMs), geometry);
    const { bytes, object } = await cutWindow({ audioFile, sessionId: SESSION, geometry });
    assert.ok(bytes.equals(expectedBytes(geometry.startMs, geometry.endMs)));
    assert.equal(object.byteLength, 44 + (geometry.endMs - geometry.startMs) * 64);
  }
  // Windows published mid-call keep their geometry once the final length is known.
  assert.deepEqual(windowGeometry(0, Infinity), windowGeometry(0, durationMs));
});

test('cutting past the committed audio is refused, never zero-filled', async (t) => {
  const root = tempRoot(t);
  writeSession(root, { frames: 1000 * 16 });
  await assert.rejects(cutWindow({ audioFile: path.join(root, SESSION, 'audio.pcm'), sessionId: SESSION,
    geometry: windowGeometry(0, 2000) }), (error) => error.code === 'audio-truncated');
});

test('four hour cap: 240 windows, window 239 is only ever cut at stop', () => {
  const beyond = (MAX_DURATION_MS + 3600000) * 16;
  assert.equal(liveReadyCount(beyond), 239);
  assert.deepEqual(finalDuration(beyond), { durationMs: MAX_DURATION_MS, truncated: true });
  assert.equal(windowCount(MAX_DURATION_MS), 240);
  const last = windowGeometry(239, MAX_DURATION_MS);
  assert.equal(last.endMs, MAX_DURATION_MS);
  assert.ok(windowGeometry(238, Infinity).endMs <= MAX_DURATION_MS);
});
