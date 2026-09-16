'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function regularFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular non-symlink file');
  return stat;
}

function readJson(file, { maxBytes = 1048576, fallback = null } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid JSON size limit');
  const stat = regularFile(file);
  if (!stat) return fallback;
  if (stat.size > maxBytes) throw new Error('JSON file exceeds size limit');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) throw new Error('Invalid JSON file');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1));
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > maxBytes || size > opened.size) throw new Error('JSON file changed during read');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function writeJson(file, value) {
  regularFile(file);
  const body = JSON.stringify(value);
  if (body === undefined) throw new TypeError('Value is not JSON serializable');
  const temporary = path.join(path.dirname(file), `.kern-${randomUUID()}.tmp`);
  let fd;
  let owned = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    owned = true;
    fs.writeFileSync(fd, `${body}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    regularFile(file);
    fs.renameSync(temporary, file);
    owned = false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (owned) fs.unlinkSync(temporary);
  }
}

module.exports = { readJson, writeJson };
