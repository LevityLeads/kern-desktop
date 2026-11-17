'use strict';

const { CallError } = require('./safe-fs');
const { cutWindow, liveReadyCount, windowCount, windowGeometry } = require('./window-cutter');

// Publishing a call to Kern, per docs/call-api-contract-v2.md:
//   POST /api/calls/live -> for every window: POST /windows, POST /upload, PUT -> POST /live-finalize
// Progress is saved after every request, so a restart repeats at most one request per window,
// and a repeat is always byte-identical (window ids derive from the bytes).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ctx: { http, save(state), signal, audioFile() -> path }
function caller(ctx, state) {
  return (route, options = {}) => ctx.http.api(state.origin, route, { ...options, signal: ctx.signal, ownerId: state.ownerId });
}

function conflict() {
  return new CallError('conflict', 'This recording changed after part of it was sent to Kern.');
}

async function bindAccount(ctx, state) {
  state.origin ||= ctx.http.origin();
  const identity = await ctx.http.identity(state.origin, { signal: ctx.signal });
  if (state.ownerId && state.ownerId !== identity.ownerId) {
    throw new CallError('origin-changed', 'This call belongs to a different Kern account.');
  }
  state.ownerId = identity.ownerId;
  state.storageOrigin = identity.storageOrigin || state.storageOrigin;
}

// Opens the remote recording once. Idempotent on the server for the same sessionId while live.
async function ensureRemote(ctx, state) {
  if (state.remoteId) return;
  await bindAccount(ctx, state);
  const opened = await caller(ctx, state)('/api/calls/live', { method: 'POST', body: { version: 1, sessionId: state.sessionId } });
  if (typeof opened.id !== 'string' || !UUID.test(opened.id)) throw new CallError('protocol', 'Kern sent an invalid call id.');
  state.remoteId = opened.id.toLowerCase();
  await ctx.save(state);
}

function windowEntry(object) {
  const { id, sha256, byteLength, windowIndex, startMs, endMs, coreStartMs, coreEndMs } = object;
  return { id, sha256, byteLength, frames: object.wav.frames, windowIndex, startMs, endMs, coreStartMs, coreEndMs,
    registered: false, uploaded: false };
}

function windowObject(entry) {
  const { id, sha256, byteLength, frames, windowIndex, startMs, endMs, coreStartMs, coreEndMs } = entry;
  return { id, kind: 'window', sha256, byteLength, wav: { sampleRate: 16000, channels: 2, bitsPerSample: 16, format: 'pcm', frames },
    windowIndex, startMs, endMs, coreStartMs, coreEndMs };
}

function sameGeometry(entry, geometry) {
  return entry.startMs === geometry.startMs && entry.endMs === geometry.endMs &&
    entry.coreStartMs === geometry.coreStartMs && entry.coreEndMs === geometry.coreEndMs;
}

async function publishWindow(ctx, state, geometry) {
  const index = geometry.windowIndex;
  const existing = state.windows[index];
  if (existing && !sameGeometry(existing, geometry)) throw conflict();
  if (existing?.uploaded) return false;
  if (!existing && index !== state.windows.length) throw conflict();
  const { bytes, object } = await cutWindow({ audioFile: await ctx.audioFile(), sessionId: state.sessionId, geometry });
  if (existing && existing.id !== object.id) throw conflict();
  const entry = existing || windowEntry(object);
  state.windows[index] = entry;
  const call = caller(ctx, state);
  const prefix = `/api/calls/${state.remoteId}`;
  if (!entry.registered) {
    const registered = await call(`${prefix}/windows`, { method: 'POST', body: { object } });
    if (registered.objectId !== object.id || registered.windowIndex !== index) {
      throw new CallError('protocol', 'Kern registered a different window than the one sent.');
    }
    entry.registered = true;
    await ctx.save(state);
  }
  const permission = await call(`${prefix}/upload`, { method: 'POST', body: { objectId: object.id } });
  if (typeof permission.signedUrl !== 'string') throw new CallError('protocol', 'Kern sent an invalid upload address.');
  await ctx.http.upload(permission.signedUrl, bytes, { signal: ctx.signal, storageOrigin: state.storageOrigin });
  entry.uploaded = true;
  await ctx.save(state);
  return true;
}

// While recording: every window whose audio (plus overlap) is already committed.
async function publishLive(ctx, state, committedFrames) {
  const ready = liveReadyCount(committedFrames);
  let published = 0;
  for (let index = 0; index < ready; index += 1) {
    ctx.signal?.throwIfAborted();
    if (await publishWindow(ctx, state, windowGeometry(index, Infinity))) published += 1;
  }
  return published;
}

// After the call: every window of the final length, including the short last one(s).
async function publishFinal(ctx, state) {
  const durationMs = state.finalFrames / 16;
  const count = windowCount(durationMs);
  if (state.windows.length > count) throw conflict();
  for (let index = 0; index < count; index += 1) {
    ctx.signal?.throwIfAborted();
    await publishWindow(ctx, state, windowGeometry(index, durationMs));
  }
}

async function finalize(ctx, state) {
  const durationMs = state.finalFrames / 16;
  if (state.windows.length !== windowCount(durationMs) || !state.windows.every(w => w.uploaded)) throw conflict();
  let result;
  try {
    result = await caller(ctx, state)(`/api/calls/${state.remoteId}/live-finalize`, {
      method: 'POST',
      body: { version: 1, sessionId: state.sessionId, durationMs, objects: state.windows.map(windowObject) },
    });
  } catch (error) {
    // Kern refuses the seal (409) when it has not seen every window's bytes. Registrations and
    // uploads are idempotent, so resend everything once rather than stranding the call.
    if (error.code !== 'conflict' || state.resentForSeal) throw error;
    state.resentForSeal = true;
    for (const entry of state.windows) entry.uploaded = false;
    await ctx.save(state);
    throw new CallError('seal-refused', 'Kern asked for the call again. Resending it.', true);
  }
  if (typeof result.state !== 'string') throw new CallError('protocol', 'Kern sent an unexpected response.');
  state.finalized = true;
  await ctx.save(state);
}

module.exports = { caller, ensureRemote, finalize, publishFinal, publishLive, publishWindow, windowObject };
