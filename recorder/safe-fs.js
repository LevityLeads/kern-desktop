'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Everything under Kern Recordings is treated as untrusted: another process (or a person) can
// replace a file with a link or a junction. These helpers refuse links, reparse escapes and
// oversized files before a single byte is parsed.

// `retry` marks errors worth retrying automatically; `code` is a short machine token.
class CallError extends Error {
  constructor(code, message, retry = false) {
    super(message);
    this.code = code;
    this.retry = retry;
  }
}

function inside(root, file) {
  const rel = path.relative(root, file);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new CallError('invalid-path', 'A recording path escapes the recordings folder.');
  }
  return file;
}

function relativeParts(relative) {
  if (typeof relative !== 'string' || !relative || /[\\:\x00-\x1f]/u.test(relative)) {
    throw new CallError('invalid-path', 'A recording path is invalid.');
  }
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) {
    throw new CallError('invalid-path', 'A recording path is invalid.');
  }
  return parts;
}

// Resolves `relative` under `root`, refusing symlinks and anything that realpaths outside root.
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
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) {
      throw new CallError('invalid-path', 'A recording path is a link.');
    }
    inside(realRoot, await fs.promises.realpath(current));
  }
  return current;
}

// Opens a regular file for reading and confirms the handle is the file that was checked.
async function openRead(root, relative) {
  const file = await safePath(root, relative);
  const before = await fs.promises.lstat(file);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new CallError('invalid-path', 'A recording file changed while it was opened.');
    }
    return { handle, stat, file };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

// Parsed JSON from a regular file no larger than maxBytes. Missing file -> ENOENT error.
async function readJsonFile(root, relative, maxBytes) {
  const { handle, stat } = await openRead(root, relative);
  try {
    if (stat.size > maxBytes) throw new CallError('invalid-file', `${relative} is too large.`);
    const body = await readExactly(handle, stat.size, 0);
    try { return JSON.parse(body.toString('utf8')); }
    catch { throw new CallError('invalid-file', `${relative} is not valid JSON.`); }
  } finally { await handle.close(); }
}

// Size of a regular file, or null when it does not exist.
async function fileSize(root, relative) {
  let file;
  try { file = await safePath(root, relative); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile()) throw new CallError('invalid-file', `${relative} is not a file.`);
  return stat.size;
}

module.exports = { CallError, safePath, openRead, readExactly, readJsonFile, fileSize };
