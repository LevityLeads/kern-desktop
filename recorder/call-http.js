'use strict';

const { CallError } = require('./safe-fs');

// Kern API client for call capture v2. Every response is untrusted: bounded, JSON-only, shape
// checked by the caller. Errors carry `retry` (transient) or code 'auth' (needs sign-in).
const MAX_JSON = 4 * 1024 * 1024;
// A window is at most 62 s of int16 stereo 16 kHz plus the WAV header (~3.97 MB).
const MAX_UPLOAD = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60000;
const UPLOAD_TIMEOUT_MS = 120000;

function originOf(value) {
  let url;
  try { url = new URL(value); } catch { throw new CallError('origin', 'Kern is not set up yet.'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new CallError('origin', 'Transcription needs a secure Kern address.');
  }
  return url.origin;
}

async function responseJson(response, max = MAX_JSON) {
  if (!/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) {
    throw new CallError('protocol', 'Kern sent an unexpected response.');
  }
  if (Number(response.headers.get('content-length')) > max) throw new CallError('protocol', 'Kern sent too much data.');
  if (!response.body?.getReader) throw new CallError('protocol', 'Kern sent an unexpected response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let dropped = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new CallError('protocol', 'Kern sent too much data.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof CallError) { await reader.cancel().catch(() => {}); throw error; }
    dropped = true;
  } finally { reader.releaseLock(); }
  if (dropped) throw new CallError('network', 'Kern could not be reached.', true);
  try {
    const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch { throw new CallError('protocol', 'Kern sent an unexpected response.'); }
}

function statusError(status, { storage = false } = {}) {
  if (!storage && (status === 401 || status === 403)) return new CallError('auth', 'Sign in to Kern to transcribe your calls.');
  if ([408, 425, 429].includes(status) || status >= 500) return new CallError('network', 'Kern is busy right now.', true);
  if (storage && (status === 401 || status === 403)) return new CallError('upload-expired', 'Upload permission expired.', true);
  if (status === 404) return new CallError('not-found', 'This call no longer exists in Kern.');
  if (status === 409) return new CallError('conflict', 'Kern and this PC disagree about this call.');
  return new CallError('rejected', 'Kern could not accept this call.');
}

class CallHttp {
  // getSession: the Electron session holding the Kern sign-in cookies (has .fetch).
  // fetchImpl: plain fetch for signed storage uploads, which must never carry Kern cookies.
  constructor({ getSession, getOrigin, fetchImpl = fetch }) {
    this.getSession = getSession;
    this.getOrigin = getOrigin;
    this.fetchImpl = fetchImpl;
  }

  origin() { return originOf(this.getOrigin()); }

  async api(origin, route, { method = 'GET', body, signal, ownerId } = {}) {
    if (this.origin() !== origin) throw new CallError('origin-changed', 'This call belongs to a different Kern address.');
    if (!/^\/api\/calls(?:\/|$)/.test(route) || route.includes('..') || route.includes('\\')) {
      throw new CallError('protocol', 'Invalid call request.');
    }
    const session = this.getSession();
    if (!session?.fetch) throw new CallError('auth', 'Open Kern and sign in to transcribe your calls.');
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > MAX_JSON) throw new CallError('size', 'This call is too large to send.');
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const response = await session.fetch(`${origin}${route}`, {
        method, body: encoded,
        headers: { accept: 'application/json', ...(encoded ? { 'content-type': 'application/json' } : {}),
          ...(ownerId ? { 'x-kern-owner-id': ownerId } : {}) },
        credentials: 'include', redirect: 'error', cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw statusError(response.status);
      }
      return await responseJson(response);
    } catch (error) {
      if (error instanceof CallError) throw error;
      if (signal?.aborted) throw new CallError('cancelled', 'Stopped.');
      throw new CallError('network', 'Kern could not be reached.', true);
    }
  }

  async identity(origin, { signal } = {}) {
    const data = await this.api(origin, '/api/calls/identity', { signal });
    if (typeof data.ownerId !== 'string' || !data.ownerId || data.ownerId.length > 128) {
      throw new CallError('auth', 'Sign in to Kern to transcribe your calls.');
    }
    let storageOrigin = null;
    if (typeof data.storageOrigin === 'string') {
      try {
        const url = new URL(data.storageOrigin);
        if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/') storageOrigin = url.origin;
      } catch { /* ignore a malformed storage origin */ }
    }
    return { ownerId: data.ownerId, storageOrigin };
  }

  // PUT to a signed storage URL. An immutable duplicate (lost acknowledgement) counts as done.
  async upload(urlValue, bytes, { signal, storageOrigin } = {}) {
    let url;
    try { url = new URL(urlValue); } catch { throw new CallError('protocol', 'Kern sent an invalid upload address.'); }
    if (url.protocol !== 'https:' || (storageOrigin ? url.origin !== storageOrigin : !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)) ||
        url.username || url.password || url.hash || !url.pathname.startsWith('/storage/v1/object/upload/sign/') ||
        !url.searchParams.has('token') || bytes.byteLength > MAX_UPLOAD) {
      throw new CallError('protocol', 'Kern sent an invalid upload address.');
    }
    const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: 'PUT', body: bytes, headers: { 'content-type': 'audio/wav' }, credentials: 'omit', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.status === 400 || response.status === 409) {
        const detail = await responseJson(response, 16384).catch(() => null);
        if (response.status === 409 || String(detail?.statusCode) === '409' || detail?.error === 'Duplicate') return { duplicate: true };
        throw statusError(response.status, { storage: true });
      }
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw statusError(response.status, { storage: true });
      return { duplicate: false };
    } catch (error) {
      if (error instanceof CallError) throw error;
      if (signal?.aborted) throw new CallError('cancelled', 'Stopped.');
      throw new CallError('network', 'The upload was interrupted.', true);
    }
  }
}

module.exports = { CallHttp, MAX_UPLOAD, originOf, responseJson, statusError };
