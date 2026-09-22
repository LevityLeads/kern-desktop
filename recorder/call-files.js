'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertSessionId } = require('./protocol');

const MAX_MANIFEST = 32 * 1024 * 1024;
const MAX_JSON = 4 * 1024 * 1024;
const MAX_UPLOAD = 20 * 1024 * 1024;
// The rendered playback file stays local and grows with call length (16 kHz mono
// 16-bit = 32 KB/s). It must never be measured against the per-object cloud cap:
// 20 MB is only 10.9 minutes. The renderer's own ceiling is 12 hours.
const MAX_PLAYBACK = 44 + 12 * 3600 * 16000 * 2;
const HASH = /^[0-9a-f]{64}$/i;

// `reason` is a short machine token naming the exact check that failed. It reaches the UI
// diagnostics and never carries a path, a device name or file contents, so it is safe to show
// and it is what turns "failed validation" into a fix on the first report.
class CallError extends Error {
  constructor(code, message, retry = false, reason = null) {
    super(message); this.code = code; this.retry = retry; this.reason = reason;
  }
}
function fail(code = 'invalid-recording', message = 'Recording files failed validation.', reason = null) {
  throw new CallError(code, message, false, reason);
}
// Same generic error, distinct reason.
function invalid(reason) { return fail('invalid-recording', 'Recording files failed validation.', reason); }
function inside(root, file) {
  const rel = path.relative(root, file);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) invalid('path-escapes-root');
  return file;
}
function relativeParts(relative) {
  if (typeof relative !== 'string' || !relative || /[\\:\x00-\x1f]/u.test(relative)) invalid('relative-path-shape');
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) invalid('relative-path-segment');
  return parts;
}
// lstat rejects junctions/symlinks; realpath catches other Windows reparse escapes.
async function safePath(root, relative, allowMissing = false) {
  const parts = relativeParts(relative);
  const realRoot = await fs.promises.realpath(root);
  let current = realRoot;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.promises.lstat(current); }
    catch (error) {
      if (allowMissing && i === parts.length - 1 && error.code === 'ENOENT') return current;
      throw error;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) invalid('path-link-or-not-directory');
    inside(realRoot, await fs.promises.realpath(current));
  }
  return current;
}
async function callDirectory(root, id) {
  const dir = await safePath(root, assertSessionId(id));
  const stat = await fs.promises.lstat(dir);
  if (!stat.isDirectory()) invalid('call-directory-missing');
  return dir;
}
async function openSafe(root, relative) {
  const file = await safePath(root, relative);
  const before = await fs.promises.lstat(file);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) invalid('file-identity-changed');
    await safePath(root, relative);
    return { handle, stat, file };
  } catch (error) { await handle.close(); throw error; }
}
async function hashFile(root, relative, expected = null, signal, maxBytes = MAX_UPLOAD) {
  const { handle, stat, file } = await openSafe(root, relative);
  try {
    if (stat.size > maxBytes) invalid('file-over-size-cap');
    if (expected && (!Number.isSafeInteger(expected.byteLength) || stat.size !== expected.byteLength ||
        !HASH.test(expected.sha256))) invalid('file-length-mismatch');
    const hash = crypto.createHash('sha256');
    let read = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
      signal?.throwIfAborted();
      read += chunk.length;
      if (read > stat.size) invalid('file-grew-while-reading');
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) invalid('file-changed-while-reading');
    const sha256 = hash.digest('hex');
    if (expected && sha256 !== expected.sha256.toLowerCase()) invalid('file-hash-mismatch');
    return { file, byteLength: stat.size, sha256 };
  } finally { await handle.close(); }
}
async function jsonFile(root, relative, maxBytes = MAX_MANIFEST) {
  const { handle, stat } = await openSafe(root, relative);
  try {
    if (stat.size > maxBytes) invalid('json-over-size-cap');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) invalid('json-short-read');
    try { return JSON.parse(buffer.subarray(0, offset).toString('utf8')); }
    catch { return invalid('json-parse'); }
  } finally { await handle.close(); }
}
async function sourceManifest(dir, id, signal) {
  const before = (await hashFile(dir, 'manifest.json', null, signal, MAX_MANIFEST)).sha256;
  const manifest = await jsonFile(dir, 'manifest.json');
  if (manifest.sessionId !== id || manifest.protocolVersion !== 1 ||
      !['stopped', 'interrupted'].includes(manifest.state)) {
    fail('not-finalized', 'Stop or recover this recording before processing it.', 'source-manifest-not-terminal');
  }
  const fingerprint = (await hashFile(dir, 'manifest.json', null, signal, MAX_MANIFEST)).sha256;
  if (before !== fingerprint) invalid('source-manifest-changed');
  return { manifest, fingerprint };
}
async function boundedFile(dir, relative, expected, signal) {
  if (expected.byteLength > MAX_UPLOAD || expected.byteLength < 1) invalid('upload-object-size');
  const { handle, stat } = await openSafe(dir, relative);
  try {
    if (stat.size !== expected.byteLength) invalid('upload-object-length');
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, Math.min(256 * 1024, buffer.length - offset), offset);
      if (!bytesRead) invalid('upload-object-short-read');
      offset += bytesRead;
    }
    if (crypto.createHash('sha256').update(buffer).digest('hex') !== expected.sha256.toLowerCase()) invalid('upload-object-hash');
    return buffer;
  } finally { await handle.close(); }
}
module.exports = { CallError, fail, invalid, safePath, callDirectory, hashFile, jsonFile, sourceManifest,
  boundedFile, MAX_MANIFEST, MAX_JSON, MAX_UPLOAD, MAX_PLAYBACK, HASH };
