'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { assertSafeId, assertSessionId } = require('./protocol');

const MANIFEST_NAME = 'manifest.json';
const JOURNAL_NAME = 'journal.ndjson';
const COMPLETE_STATES = new Set(['stopped', 'interrupted']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Resolved path escapes the recording root');
  }
  return resolvedCandidate;
}

function sessionDirectory(root, sessionId) {
  return ensureInside(root, path.join(root, assertSessionId(sessionId)));
}

function manifestPath(root, sessionId) {
  return path.join(sessionDirectory(root, sessionId), MANIFEST_NAME);
}

function readManifest(root, sessionId) {
  const manifest = readJson(manifestPath(root, sessionId));
  if (manifest.sessionId !== sessionId || manifest.protocolVersion !== 1) {
    throw new Error('Recording manifest identity or protocol does not match');
  }
  return manifest;
}

function readJournal(root, sessionId) {
  const filePath = path.join(sessionDirectory(root, sessionId), JOURNAL_NAME);
  let body;
  try {
    body = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const endsWithNewline = body.endsWith('\n');
  const lines = body.split('\n');
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      const isIncompleteTail = index === lines.length - 1 && !endsWithNewline;
      if (isIncompleteTail) break;
      throw new Error(`Invalid journal record at line ${index + 1}`);
    }
  }
  return records;
}

function listSessions(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const sessions = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    try {
      const manifest = readManifest(root, entry.name);
      const finalisedSegments = Array.isArray(manifest.segments)
        ? manifest.segments.filter((segment) => segment.status === 'finalised').length
        : 0;
      sessions.push({
        sessionId: manifest.sessionId,
        state: manifest.state,
        startedAtUtc: manifest.startedAtUtc,
        endedAtUtc: manifest.endedAtUtc || null,
        durationMs: manifest.durationMs || 0,
        sizeBytes: manifest.sizeBytes || 0,
        trackCount: Array.isArray(manifest.tracks) ? manifest.tracks.length : 0,
        segmentCount: finalisedSegments,
        recoverable: !COMPLETE_STATES.has(manifest.state),
        failure: manifest.failure || null,
      });
    } catch (error) {
      sessions.push({
        sessionId: entry.name,
        state: 'quarantined',
        recoverable: false,
        failure: { code: 'invalid-manifest', message: error.message },
      });
    }
  }

  return sessions.sort((a, b) => String(b.startedAtUtc || '').localeCompare(String(a.startedAtUtc || '')));
}

function findSegment(manifest, trackId, segmentId) {
  if (!Array.isArray(manifest.segments)) throw new Error('Manifest has no segment catalog');
  const segment = manifest.segments.find(
    (candidate) =>
      candidate.status === 'finalised' &&
      candidate.trackId === trackId &&
      candidate.segmentId === segmentId
  );
  if (!segment) throw new Error('Finalised recording segment was not found');
  return segment;
}

function resolveFinalisedSegmentFile(sessionRoot, segment) {
  const filePath = ensureInside(sessionRoot, path.join(sessionRoot, segment.relativePath));
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Recording segment is not a file');
  if (!Number.isSafeInteger(segment.byteLength) || segment.byteLength <= 0 || stat.size !== segment.byteLength) {
    throw new Error('Recording segment byte length does not match its manifest');
  }
  if (typeof segment.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(segment.sha256)) {
    throw new Error('Recording segment checksum is invalid');
  }
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const expected = Buffer.from(segment.sha256, 'hex');
  const actual = Buffer.from(checksum, 'hex');
  if (!crypto.timingSafeEqual(actual, expected)) {
    throw new Error('Recording segment checksum does not match its manifest');
  }
  return filePath;
}

function resolveSegment(root, payload) {
  const manifest = readManifest(root, payload.sessionId);
  const segment = findSegment(manifest, payload.trackId, payload.segmentId);
  const sessionRoot = sessionDirectory(root, payload.sessionId);
  const filePath = resolveFinalisedSegmentFile(sessionRoot, segment);
  return { manifest, segment, filePath };
}

function buildPlaybackUrl(root, payload) {
  const { filePath } = resolveSegment(root, payload);
  return pathToFileURL(filePath).toString();
}

function copyFileExclusive(source, destination) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function exportSession(root, sessionId, destinationRoot) {
  const manifest = readManifest(root, sessionId);
  fs.mkdirSync(destinationRoot, { recursive: true });
  const timestamp = String(manifest.startedAtUtc || new Date().toISOString()).replace(/[:.]/g, '-');
  let target = path.join(destinationRoot, `Kern recording ${timestamp}`);
  for (let suffix = 2; fs.existsSync(target); suffix += 1) {
    target = path.join(destinationRoot, `Kern recording ${timestamp} (${suffix})`);
  }
  fs.mkdirSync(target, { mode: 0o700 });

  const sourceRoot = sessionDirectory(root, sessionId);
  for (const segment of manifest.segments || []) {
    if (segment.status !== 'finalised') continue;
    const source = resolveFinalisedSegmentFile(sourceRoot, segment);
    const name = `${assertSafeId(segment.trackId, 'trackId')}-${String(segment.sequence).padStart(6, '0')}.wav`;
    copyFileExclusive(source, path.join(target, name));
  }
  copyFileExclusive(manifestPath(root, sessionId), path.join(target, MANIFEST_NAME));

  const journalSource = path.join(sourceRoot, JOURNAL_NAME);
  if (fs.existsSync(journalSource)) copyFileExclusive(journalSource, path.join(target, JOURNAL_NAME));
  return target;
}

function createSessionId() {
  return crypto.randomUUID();
}

module.exports = {
  COMPLETE_STATES,
  MANIFEST_NAME,
  JOURNAL_NAME,
  buildPlaybackUrl,
  createSessionId,
  ensureInside,
  exportSession,
  listSessions,
  manifestPath,
  readJournal,
  readManifest,
  resolveSegment,
  sessionDirectory,
};
