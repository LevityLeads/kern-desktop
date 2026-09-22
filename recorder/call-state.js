'use strict';

const fs = require('node:fs');
const { readJson, writeJsonWithRetry } = require('./atomic-json');
const { callDirectory, safePath, jsonFile, CallError } = require('./call-files');

const JOB_FILE = 'processing.json';
const RESUMABLE = new Set(['preparing', 'ready', 'uploading', 'transcribing', 'retrying']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LIVE_WINDOWS = 120;
// Mid-call publishing progress. Absent in state files written before live publishing existed.
const LIVE_DEFAULTS = { live: false, liveWindows: 0, liveError: null };
// Set once the transcript is stored and the local audio (segments/, derived/) has been discarded.
const PRUNE_DEFAULTS = { audioPruned: false };
function fresh(id) {
  return { version: 1, sessionId: id, state: 'local', progress: 0, error: null,
    consent: false, requested: false, preparePending: false, origin: null, ownerId: null, storageOrigin: null,
    remoteId: null, fingerprint: null, uploaded: [], retryCount: 0, nextAttemptAt: 0, warnings: [], ...LIVE_DEFAULTS, ...PRUNE_DEFAULTS };
}
function validLive(value) {
  return (value.live === undefined || typeof value.live === 'boolean') &&
    (value.liveWindows === undefined || (Number.isSafeInteger(value.liveWindows) && value.liveWindows >= 0 && value.liveWindows <= MAX_LIVE_WINDOWS)) &&
    (value.liveError === undefined || value.liveError === null || (typeof value.liveError === 'string' && value.liveError.length <= 200)) &&
    (value.audioPruned === undefined || typeof value.audioPruned === 'boolean');
}
function validState(value, id) {
  if (!value || value.version !== 1 || value.sessionId !== id ||
      typeof value.state !== 'string' || !Array.isArray(value.uploaded) || !validLive(value) ||
      value.uploaded.length > 8192 || value.uploaded.some(u => typeof u !== 'string' || !/^[0-9a-f-]{36}$/.test(u)) ||
      (value.remoteId !== null && !UUID.test(value.remoteId)) ||
      (value.ownerId !== null && (typeof value.ownerId !== 'string' || value.ownerId.length > 128)) ||
      (value.storageOrigin !== null && typeof value.storageOrigin !== 'string') ||
      typeof value.consent !== 'boolean' ||
      typeof value.requested !== 'boolean' || typeof value.preparePending !== 'boolean' ||
      !Number.isSafeInteger(value.retryCount) || value.retryCount < 0 || value.retryCount > 8 ||
      !Number.isFinite(value.nextAttemptAt) || value.nextAttemptAt < 0 ||
      (value.uploadFinalized === true && (!Number.isSafeInteger(value.durationMs) || value.durationMs < 1 || value.durationMs > 7200000))) {
    throw new CallError('invalid-state', 'Local processing state is damaged.');
  }
  for (const [key, fallback] of Object.entries({ ...LIVE_DEFAULTS, ...PRUNE_DEFAULTS })) if (value[key] === undefined) value[key] = fallback;
  return value;
}
class CallState {
  constructor(root, settingsPath) {
    this.root = root; this.settingsPath = settingsPath;
    this.preferenceWrite = Promise.resolve();
  }
  async directory(id) { return callDirectory(this.root, id); }
  async load(id) {
    const dir = await this.directory(id);
    try { return validState(await jsonFile(dir, JOB_FILE, 8 * 1024 * 1024), id); }
    catch (error) { if (error.code === 'ENOENT') return fresh(id); throw error; }
  }
  async save(value) {
    const dir = await this.directory(value.sessionId);
    const file = await safePath(dir, JOB_FILE, true);
    await writeJsonWithRetry(file, value);
  }
  // `liveCalls` gates mid-call window publishing (the live copilot). It has no UI yet and defaults
  // off, so the capture foundation can be proven on its own before the live path runs on top of it.
  // Enable by adding "liveCalls": true to call-settings.json.
  async preference() {
    try {
      const value = await readJson(this.settingsPath);
      return { enabled: value?.cloudTranscription === true, liveCalls: value?.liveCalls === true };
    } catch (error) {
      if (error.code === 'ENOENT') return { enabled: false, liveCalls: false };
      throw new CallError('settings', 'Transcription preference could not be read.');
    }
  }
  async setPreference(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    const write = this.preferenceWrite.catch(() => {}).then(async () => {
      // Merge so a toggle from the UI never erases a setting it does not own.
      let existing = {};
      try { existing = await readJson(this.settingsPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const current = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
      await writeJsonWithRetry(this.settingsPath, { ...current, version: 1, cloudTranscription: enabled });
    });
    this.preferenceWrite = write;
    await write;
    return { enabled };
  }
  async pending() {
    let entries;
    try { entries = await fs.promises.readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const ids = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      try {
        const state = await this.load(entry.name);
        if (RESUMABLE.has(state.state) && (state.preparePending || (state.requested && state.consent))) ids.push(entry.name);
      } catch { /* Quarantined call state is not consent to upload. Explicit action surfaces validation failure. */ }
    }
    return ids;
  }
}
module.exports = { CallState, fresh };
