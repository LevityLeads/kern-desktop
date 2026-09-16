'use strict';

const { CallError, MAX_JSON, MAX_UPLOAD } = require('./call-files');

function originOf(value) {
  let url;
  try { url = new URL(value); } catch { throw new CallError('origin', 'Kern connection is not configured.'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new CallError('origin', 'Cloud transcription requires a secure Kern connection.');
  }
  return url.origin;
}
async function responseJson(response, max = MAX_JSON) {
  if (!/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) {
    throw new CallError('protocol', 'Kern returned an invalid response.');
  }
  const length = Number(response.headers.get('content-length'));
  if (length > max) throw new CallError('protocol', 'Kern response is too large.');
  if (!response.body?.getReader) throw new CallError('protocol', 'Kern returned an invalid response.');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  let readError = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new CallError('protocol', 'Kern response is too large.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof CallError) { await reader.cancel().catch(() => {}); throw error; }
    // A dropped/truncated read is a transport failure, not a malformed body: retry.
    readError = true;
  } finally { reader.releaseLock(); }
  if (readError) throw new CallError('network', 'Kern could not be reached. Retrying.', true);
  try {
    const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new CallError('protocol', 'Kern returned an invalid response.'); }
}
function statusError(status, storage = false) {
  if (!storage && [401, 403].includes(status)) return new CallError('auth', 'Sign in to Kern, then retry transcription.');
  if ([408, 425, 429].includes(status) || status >= 500) {
    return new CallError('network', 'Cloud transcription is temporarily unavailable. Retrying.', true);
  }
  if (storage && [401, 403].includes(status)) return new CallError('upload-expired', 'Upload permission expired. Retrying.', true);
  if (status === 409) return new CallError('conflict', 'This call changed after upload. Transcription stopped safely.');
  return new CallError('rejected', 'Kern could not accept this call.');
}
class CallHttp {
  constructor({ getSession, getOrigin }) { this.getSession = getSession; this.getOrigin = getOrigin; }
  origin() { return originOf(this.getOrigin()); }
  async api(origin, route, { method = 'GET', body, signal, ownerId } = {}) {
    if (this.origin() !== origin) throw new CallError('origin-changed', 'Kern connection changed. Retry explicitly to continue.');
    if (!/^\/api\/calls(?:\/|$)/.test(route) || route.includes('..') || route.includes('\\')) throw new CallError('protocol', 'Invalid call request.');
    const session = this.getSession();
    if (!session?.fetch) throw new CallError('auth', 'Open Kern and sign in before transcribing.');
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > MAX_JSON) throw new CallError('size', 'Recording inventory is too large.');
    const timeout = AbortSignal.timeout(60000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await session.fetch(`${origin}${route}`, { method, body: encoded,
        headers: { accept: 'application/json', ...(encoded ? { 'content-type': 'application/json' } : {}),
          ...(ownerId ? { 'x-kern-owner-id': ownerId } : {}) },
        credentials: 'include', redirect: 'error', cache: 'no-store', signal: combined });
      if (this.getSession() !== session || this.origin() !== origin) throw new CallError('auth', 'Kern session changed. Retry transcription.');
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw statusError(response.status);
      }
      return await responseJson(response);
    } catch (error) {
      if (error instanceof CallError) throw error;
      if (signal?.aborted) throw new CallError('cancelled', 'Processing paused.');
      throw new CallError('network', 'Kern could not be reached. Retrying.', true);
    }
  }
  async identity(origin, { signal } = {}) {
    const data = await this.api(origin, '/api/calls/identity', { signal });
    if (typeof data.ownerId !== 'string' || !data.ownerId || data.ownerId.length > 128) {
      throw new CallError('auth', 'Sign in to Kern before transcribing.');
    }
    let storageOrigin = null;
    if (typeof data.storageOrigin === 'string') {
      try {
        const url = new URL(data.storageOrigin);
        if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/') storageOrigin = url.origin;
      } catch { /* ignore malformed storage origin */ }
    }
    return { ownerId: data.ownerId, storageOrigin };
  }
  async upload(urlValue, bytes, { signal, storageOrigin } = {}) {
    let url;
    try { url = new URL(urlValue); } catch { throw new CallError('protocol', 'Invalid upload permission.'); }
    const host = storageOrigin || null;
    if (url.protocol !== 'https:' || (host ? url.origin !== host : !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)) ||
        url.username || url.password || url.hash ||
        !url.pathname.startsWith('/storage/v1/object/upload/sign/') || !url.searchParams.has('token') ||
        bytes.byteLength > MAX_UPLOAD) throw new CallError('protocol', 'Invalid upload permission.');
    try {
      const response = await fetch(url, { method: 'PUT', body: bytes,
        headers: { 'content-type': 'audio/wav' }, credentials: 'omit', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
      if (response.status === 400) {
        // Supabase reports an immutable duplicate as HTTP 400 with a structured 409 code.
        const detail = await responseJson(response, 16384).catch(() => null);
        if (detail && (String(detail.statusCode) === '409' || detail.error === 'Duplicate')) throw statusError(409, true);
      } else await response.body?.cancel().catch(() => {});
      if (!response.ok) throw statusError(response.status, true);
    } catch (error) {
      if (error instanceof CallError) throw error;
      if (signal?.aborted) throw new CallError('cancelled', 'Processing paused.');
      throw new CallError('network', 'Audio upload was interrupted. Retrying.', true);
    }
  }
}
module.exports = { CallHttp, originOf, responseJson, statusError };
