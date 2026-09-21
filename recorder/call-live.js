'use strict';

const { CallError, jsonFile, hashFile, boundedFile, fail } = require('./call-files');
const { isActiveState } = require('./protocol');
const { renderCall } = require('./call-render');
const { validateLiveManifest, windowObject, MAX_LIVE_WINDOWS } = require('./call-derived');
const { bind } = require('./call-work');

const WINDOW_MS = 60000;
// Audio this close to the newest checkpoint may still be settling in the helper; leave it out.
const TAIL_MS = 2000;
// A track whose newest checkpoint trails the others by more than this has stopped publishing
// (a dead headset, a device swap) and must not hold every later window hostage.
const STALE_TRACK_MS = 15000;
const MAX_FAILURES = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Milliseconds of audio every still-publishing track has finalised, from the untrusted capture manifest.
// Exact integer arithmetic: ticks are 100 ns and a twelve-hour call exceeds 2^32 of them.
function availableMs(manifest) {
  const frequency = manifest?.timelineFrequency, origin = manifest?.timelineOriginTicks;
  if (!Number.isSafeInteger(frequency) || frequency < 1 || !Number.isSafeInteger(origin) || !Array.isArray(manifest.segments)) return null;
  const lastEnd = new Map();
  for (const segment of manifest.segments) {
    if (!segment || segment.status !== 'finalised' || typeof segment.trackId !== 'string' ||
        !Number.isSafeInteger(segment.timelineEndTicks) || segment.timelineEndTicks < origin) continue;
    const ms = Number((BigInt(segment.timelineEndTicks - origin) * 1000n) / BigInt(frequency));
    if (ms > (lastEnd.get(segment.trackId) ?? -1)) lastEnd.set(segment.trackId, ms);
  }
  if (!lastEnd.size) return null;
  const newest = Math.max(...lastEnd.values());
  return Math.min(...[...lastEnd.values()].filter(ms => ms >= newest - STALE_TRACK_MS));
}

class LivePublisher {
  constructor(processor, id, { intervalMs = 5000 } = {}) {
    this.processor = processor; this.id = id; this.intervalMs = intervalMs;
    this.controller = new AbortController();
    this.signal = AbortSignal.any([processor.abort.signal, this.controller.signal]);
    this.stopped = false; this.failures = 0; this.timer = null; this.current = null;
    this.arm();
  }
  arm() {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; this.tick().finally(() => this.arm()); }, this.intervalMs);
    this.timer.unref?.();
  }
  halt() {
    this.stopped = true;
    clearTimeout(this.timer); this.timer = null;
    this.controller.abort();
  }
  // Serialised behind the call's lock so a tick never interleaves with a save or with post-call processing.
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.current) return this.current;
    this.current = this.processor.lock(this.id, () => this.run()).catch(() => {}).finally(() => { this.current = null; });
    return this.current;
  }
  async run() {
    if (this.stopped) return;
    let state = null;
    try {
      state = await this.processor.store.load(this.id);
      const outcome = await this.publish(state);
      if (outcome === 'done') { this.halt(); return; }
      this.failures = 0;
    } catch (error) {
      if (this.stopped || this.signal.aborted) return;
      const code = error instanceof CallError ? error.code : 'unexpected-error';
      const fatal = code === 'auth' || code === 'origin-changed';
      this.failures += 1;
      if (!fatal && this.failures < MAX_FAILURES) return;
      this.halt();
      // The capture itself is untouched: state.state stays as it was and the post-call path recovers everything.
      if (state) { state.liveError = code; await this.processor.save(state).catch(() => {}); }
    }
  }
  async publish(state) {
    const { processor, id, signal } = this;
    const { store, http, helperPath, spawnProcess } = processor;
    if (state.state !== 'recording' || !state.consent || !state.origin || state.origin !== http.origin()) return 'done';
    if (state.liveWindows >= MAX_LIVE_WINDOWS) return 'done';
    const dir = await store.directory(id);
    const manifest = await jsonFile(dir, 'manifest.json');
    if (manifest.sessionId !== id || !isActiveState(manifest.state)) return 'done';
    const available = availableMs(manifest);
    if (available === null) return 'idle';
    const through = available - TAIL_MS;
    if (through < (state.liveWindows + 1) * WINDOW_MS + TAIL_MS) return 'idle';
    const api = (route, options = {}) => http.api(state.origin, route, { ...options, signal, ownerId: state.ownerId });
    if (!state.remoteId) {
      await bind(processor, state);
      const opened = await api('/api/calls/live', { method: 'POST', body: { version: 1, sessionId: id.toLowerCase() } });
      if (!UUID.test(opened.id)) fail('protocol', 'Kern returned an invalid call identity.');
      state.remoteId = opened.id; state.live = true;
      await processor.save(state);
    }
    const prefix = `/api/calls/${state.remoteId}`;
    await renderCall(helperPath, dir, { signal, spawnProcess, through });
    const live = await validateLiveManifest(dir, id);
    for (let index = state.liveWindows; index < live.windows.length; index += 1) {
      signal.throwIfAborted();
      const w = live.windows[index];
      await hashFile(dir, w.relativePath, w, signal);
      const object = windowObject(id, w, index);
      const registered = await api(`${prefix}/windows`, { method: 'POST', body: { object } });
      if (registered.objectId !== object.id || registered.windowIndex !== index) fail('protocol', 'Kern registered the wrong window.');
      const permission = await api(`${prefix}/upload`, { method: 'POST', body: { objectId: object.id } });
      const bytes = await boundedFile(dir, w.relativePath, object, signal);
      try { await http.upload(permission.signedUrl, bytes, { signal, storageOrigin: state.storageOrigin }); }
      catch (error) {
        // An immutable duplicate means an earlier tick's acknowledgement was lost; the bytes are already there.
        if (error.code !== 'conflict') throw error;
      }
      if (!state.uploaded.includes(object.id)) state.uploaded.push(object.id);
      state.liveWindows = index + 1;
      await processor.save(state);
    }
    return 'published';
  }
  async stop() {
    this.halt();
    await this.current;
  }
}
function startLivePublisher(processor, id, options) {
  const publisher = new LivePublisher(processor, id, options);
  return { stop: () => publisher.stop(), tick: () => publisher.tick() };
}
module.exports = { startLivePublisher, availableMs };
