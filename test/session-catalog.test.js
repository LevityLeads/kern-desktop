'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  buildPlaybackUrl,
  exportSession,
  listSessions,
  readJournal,
  readManifest,
  resolveSegment,
} = require('../recorder/session-catalog');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-catalog-'));
  const sessionId = crypto.randomUUID();
  const sessionPath = path.join(root, sessionId);
  const segmentPath = path.join(sessionPath, 'segments', 'microphone-abc', '000000-segment.wav');
  fs.mkdirSync(path.dirname(segmentPath), { recursive: true });
  fs.writeFileSync(segmentPath, Buffer.from('RIFF fake fixture'));
  const segmentBytes = fs.readFileSync(segmentPath);
  const manifest = {
    protocolVersion: 1,
    manifestVersion: 1,
    sessionId,
    state: 'stopped',
    startedAtUtc: '2026-09-15T12:00:00.000Z',
    endedAtUtc: '2026-09-15T12:01:00.000Z',
    durationMs: 60000,
    sizeBytes: fs.statSync(segmentPath).size,
    tracks: [{ trackId: 'microphone-abc', name: 'Test mic' }],
    segments: [{
      segmentId: 'segment',
      trackId: 'microphone-abc',
      sequence: 0,
      relativePath: 'segments/microphone-abc/000000-segment.wav',
      status: 'finalised',
      byteLength: segmentBytes.length,
      sha256: crypto.createHash('sha256').update(segmentBytes).digest('hex'),
    }],
  };
  fs.writeFileSync(path.join(sessionPath, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(sessionPath, 'journal.ndjson'), '{"eventName":"session-started"}\n');
  return { root, sessionId, segmentPath, manifest };
}

test('catalog lists and reads valid sessions', (context) => {
  const data = fixture();
  context.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  assert.equal(listSessions(data.root)[0].segmentCount, 1);
  assert.equal(readManifest(data.root, data.sessionId).sessionId, data.sessionId);
});

test('segment resolution never trusts renderer paths', (context) => {
  const data = fixture();
  context.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const resolved = resolveSegment(data.root, {
    sessionId: data.sessionId,
    trackId: 'microphone-abc',
    segmentId: 'segment',
  });
  assert.equal(resolved.filePath, data.segmentPath);
  assert.match(buildPlaybackUrl(data.root, {
    sessionId: data.sessionId,
    trackId: 'microphone-abc',
    segmentId: 'segment',
  }), /^file:/);
});

test('export copies only catalogued finalised segments', (context) => {
  const data = fixture();
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-export-'));
  context.after(() => {
    fs.rmSync(data.root, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  });

  const exported = exportSession(data.root, data.sessionId, destination);
  assert.deepEqual(fs.readdirSync(exported).sort(), [
    'journal.ndjson',
    'manifest.json',
    'segments',
  ]);
  const exportedManifest = JSON.parse(fs.readFileSync(path.join(exported, 'manifest.json'), 'utf8'));
  for (const segment of exportedManifest.segments) {
    const bytes = fs.readFileSync(path.join(exported, segment.relativePath));
    assert.equal(bytes.length, segment.byteLength);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), segment.sha256);
  }
});

test('journal reader ignores only an incomplete final record', (context) => {
  const data = fixture();
  context.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const journal = path.join(data.root, data.sessionId, 'journal.ndjson');
  fs.appendFileSync(journal, '{"eventName":"unfinished"');

  assert.deepEqual(readJournal(data.root, data.sessionId), [{ eventName: 'session-started' }]);
});

test('journal reader rejects a malformed complete record', (context) => {
  const data = fixture();
  context.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const journal = path.join(data.root, data.sessionId, 'journal.ndjson');
  fs.appendFileSync(journal, '{bad-json}\n');

  assert.throws(() => readJournal(data.root, data.sessionId), /line 2/);
});

test('playback and export reject a segment changed after manifest publication', (context) => {
  const data = fixture();
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-export-'));
  context.after(() => {
    fs.rmSync(data.root, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  });
  fs.appendFileSync(data.segmentPath, 'tampered');

  const payload = {
    sessionId: data.sessionId,
    trackId: 'microphone-abc',
    segmentId: 'segment',
  };
  assert.throws(() => resolveSegment(data.root, payload), /byte length/);
  assert.throws(() => exportSession(data.root, data.sessionId, destination), /byte length/);
});

test('linked segment files cannot escape the recording directory', (context) => {
  const data = fixture();
  context.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const target = path.join(data.root, 'outside.wav');
  fs.copyFileSync(data.segmentPath, target);
  fs.unlinkSync(data.segmentPath);
  try { fs.symlinkSync(target, data.segmentPath); }
  catch (error) { if (error.code === 'EPERM') return context.skip('Symlink privilege unavailable'); throw error; }
  assert.throws(() => resolveSegment(data.root, {
    sessionId: data.sessionId, trackId: 'microphone-abc', segmentId: 'segment',
  }), /symlink/);
});

test('manifest path traversal is rejected even if manifest is tampered', (context) => {
  const data = fixture();
  context.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  data.manifest.segments[0].relativePath = '../../outside.wav';
  fs.writeFileSync(path.join(data.root, data.sessionId, 'manifest.json'), JSON.stringify(data.manifest));

  assert.throws(() => resolveSegment(data.root, {
    sessionId: data.sessionId,
    trackId: 'microphone-abc',
    segmentId: 'segment',
  }), /escapes/);
});
