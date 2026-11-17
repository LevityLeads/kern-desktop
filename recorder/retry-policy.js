'use strict';

const { CallError } = require('./safe-fs');

// How a failed processing step is handled. There is no attempt limit: a transient failure keeps
// retrying for as long as the app runs, backing off to one try every five minutes, and a
// network-online event, wake from sleep, or app launch retries immediately.
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const TRANSIENT_FS = new Set(['EBUSY', 'EPERM', 'EACCES', 'EIO', 'ENOSPC', 'EMFILE', 'ENFILE', 'EAGAIN', 'ETIMEDOUT']);

function backoffDelay(attempts) {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(Math.max(0, attempts), 20));
}

// 'cancelled' | 'retry' | 'auth' | 'fatal'
function classify(error) {
  if (error instanceof CallError) {
    if (error.code === 'cancelled') return 'cancelled';
    if (error.code === 'auth') return 'auth';
    return error.retry ? 'retry' : 'fatal';
  }
  if (error?.name === 'AbortError') return 'cancelled';
  if (TRANSIENT_FS.has(error?.code)) return 'retry';
  return 'fatal';
}

// One plain-English sentence per failure, safe to show: no paths, no device names.
function describe(error) {
  if (error instanceof CallError) return error.message;
  if (error?.code === 'ENOSPC') return 'The disk is full.';
  if (TRANSIENT_FS.has(error?.code)) return 'The recording files are busy. Trying again shortly.';
  if (error?.code === 'ENOENT') return 'Some of this call\'s files are missing.';
  return 'Something went wrong processing this call.';
}

function errorRecord(error, kind) {
  const raw = typeof error?.code === 'string' ? error.code.toLowerCase().replace(/[^a-z0-9_-]/g, '') : '';
  return {
    code: /^[a-z]/.test(raw) ? raw.slice(0, 64) : 'unexpected',
    message: describe(error).slice(0, 300),
    retry: kind === 'retry',
  };
}

module.exports = { BASE_DELAY_MS, MAX_DELAY_MS, backoffDelay, classify, describe, errorRecord };
