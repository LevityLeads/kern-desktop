'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertSessionId } = require('./protocol');

const MAX_MANIFEST = 32 * 1024 * 1024;
const MAX_JSON = 4 * 1024 * 1024;
const MAX_UPLOAD = 20 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/i;

class CallError extends Error {
  constructor(code, message, retry = false) {
    super(message); this.code = code; this.retry = retry;
  }
}
function fail(code = 'invalid-recording', message = 'Recording files failed validation.') {
  throw new CallError(code, message);
}
function inside(root, file) {
  const rel = path.relative(root, file);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail();
  return file;
}
function relativeParts(relative) {
  if (typeof relative !== 'string' || !relative || /[\\:\x00-\x1f]/u.test(relative)) fail();
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) fail();
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
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) fail();
    inside(realRoot, await fs.promises.realpath(current));
  }
  return current;
}
async function callDirectory(root, id) {
  const dir = await safePath(root, assertSessionId(id));
  const stat = await fs.promises.lstat(dir);
  if (!stat.isDirectory()) fail();
  return dir;
}
async function openSafe(root, relative) {
  const file = await safePath(root, relative);
  const before = await fs.promises.lstat(file);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) fail();
    await safePath(root, relative);
    return { handle, stat, file };
  } catch (error) { await handle.close(); throw error; }
}
async function hashFile(root, relative, expected = null, signal, maxBytes = MAX_UPLOAD) {
  const { handle, stat, file } = await openSafe(root, relative);
  try {
    if (stat.size > maxBytes) fail();
    if (expected && (!Number.isSafeInteger(expected.byteLength) || stat.size !== expected.byteLength ||
        !HASH.test(expected.sha256))) fail();
    const hash = crypto.createHash('sha256');
    let read = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
      signal?.throwIfAborted();
      read += chunk.length;
      if (read > stat.size) fail();
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail();
    const sha256 = hash.digest('hex');
    if (expected && sha256 !== expected.sha256.toLowerCase()) fail();
    return { file, byteLength: stat.size, sha256 };
  } finally { await handle.close(); }
}
async function jsonFile(root, relative, maxBytes = MAX_MANIFEST) {
  const { handle, stat } = await openSafe(root, relative);
  try {
    if (stat.size > maxBytes) fail();
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) fail();
    try { return JSON.parse(buffer.subarray(0, offset).toString('utf8')); }
    catch { return fail(); }
  } finally { await handle.close(); }
}
async function sourceManifest(dir, id, signal) {
  const before = (await hashFile(dir, 'manifest.json', null, signal, MAX_MANIFEST)).sha256;
  const manifest = await jsonFile(dir, 'manifest.json');
  if (manifest.sessionId !== id || manifest.protocolVersion !== 1 ||
      !['stopped', 'interrupted'].includes(manifest.state)) {
    fail('not-finalized', 'Stop or recover this recording before processing it.');
  }
  const fingerprint = (await hashFile(dir, 'manifest.json', null, signal, MAX_MANIFEST)).sha256;
  if (before !== fingerprint) fail();
  return { manifest, fingerprint };
}
async function boundedFile(dir, relative, expected, signal) {
  if (expected.byteLength > MAX_UPLOAD || expected.byteLength < 1) fail();
  const { handle, stat } = await openSafe(dir, relative);
  try {
    if (stat.size !== expected.byteLength) fail();
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, Math.min(256 * 1024, buffer.length - offset), offset);
      if (!bytesRead) fail();
      offset += bytesRead;
    }
    if (crypto.createHash('sha256').update(buffer).digest('hex') !== expected.sha256.toLowerCase()) fail();
    return buffer;
  } finally { await handle.close(); }
}
module.exports = { CallError, fail, safePath, callDirectory, hashFile, jsonFile, sourceManifest,
  boundedFile, MAX_MANIFEST, MAX_JSON, MAX_UPLOAD, HASH };
