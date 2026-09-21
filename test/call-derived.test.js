'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateDerived } = require('../recorder/call-derived');
const { MAX_UPLOAD } = require('../recorder/call-files');

const SESSION = '3d6f0f5a-1b6b-4c1e-9a6e-2f8d6c1e0b11';
const RATE = 16000, CORE = 60 * RATE, OVERLAP = RATE;

function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function wav(samples) {
  // Header bytes are not validated here; only byte length and hash are.
  return Buffer.alloc(44 + samples * 2);
}
// Lays out a complete derived set exactly as the native renderer publishes it.
function renderedSession(root, sampleCount) {
  const dir = path.join(root, SESSION);
  fs.mkdirSync(path.join(dir, 'derived'), { recursive: true });
  const manifest = Buffer.from(JSON.stringify({ sessionId: SESSION, protocolVersion: 1, state: 'stopped', tracks: [], segments: [] }));
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifest);
  const audio = wav(sampleCount);
  fs.writeFileSync(path.join(dir, 'derived', 'call.wav'), audio);
  const windows = [];
  for (let i = 0; i < Math.ceil(sampleCount / CORE); i += 1) {
    const coreStart = i * CORE, coreEnd = Math.min(sampleCount, coreStart + CORE);
    const start = Math.max(0, coreStart - OVERLAP), end = Math.min(sampleCount, coreEnd + OVERLAP);
    const name = `window-${String(i).padStart(6, '0')}`;
    const bytes = wav(end - start);
    fs.writeFileSync(path.join(dir, 'derived', `${name}.wav`), bytes);
    windows.push({ windowId: name, relativePath: `derived/${name}.wav`, startSample: start, endSample: end,
      coreStartSample: coreStart, coreEndSample: coreEnd, byteLength: bytes.length, sha256: sha(bytes) });
  }
  fs.writeFileSync(path.join(dir, 'derived', 'manifest.json'), JSON.stringify({
    version: 1, rendererVersion: 'kern-call-render-1', complete: true, sessionId: SESSION,
    sourceFingerprint: sha(manifest), sampleRate: RATE, channels: 1, bitsPerSample: 16, sampleCount,
    durationSeconds: sampleCount / RATE, sourceIntegrity: 'verified',
    audio: { relativePath: 'derived/call.wav', byteLength: audio.length, sha256: sha(audio) }, windows, warnings: [],
  }));
  return dir;
}

test('a rendered call longer than the per-object cloud cap still validates for playback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-derived-'));
  try {
    // 21 MiB of playback audio: ~11.5 minutes, past the 20 MiB per-object upload cap.
    const sampleCount = (21 * 1024 * 1024) / 2;
    assert.equal(sampleCount % 16, 0);
    const dir = renderedSession(root, sampleCount);
    assert.ok(fs.statSync(path.join(dir, 'derived', 'call.wav')).size > MAX_UPLOAD);
    const validated = await validateDerived(dir, SESSION, {});
    assert.equal(validated.derived.sampleCount, sampleCount);
    assert.equal(validated.derived.windows.length, 12);
    assert.ok(validated.playbackFile.endsWith('call.wav'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a rendered call past the renderer ceiling is still rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-derived-'));
  try {
    const dir = renderedSession(root, 16 * 16);
    const derivedPath = path.join(dir, 'derived', 'manifest.json');
    const derived = JSON.parse(fs.readFileSync(derivedPath, 'utf8'));
    derived.sampleCount = 12 * 3600 * RATE + 16;
    derived.durationSeconds = derived.sampleCount / RATE;
    derived.audio.byteLength = 44 + derived.sampleCount * 2;
    fs.writeFileSync(derivedPath, JSON.stringify(derived));
    await assert.rejects(validateDerived(dir, SESSION, {}), e => e.code === 'invalid-recording');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
