'use strict';

const fs = require('node:fs');
const { readJson, writeJsonWithRetry } = require('./atomic-json');
const { callDirectory, safePath, jsonFile, CallError } = require('./call-files');

const JOB_FILE = 'processing.json';
const RESUMABLE = new Set(['preparing', 'ready', 'uploading', 'transcribing', 'retrying']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fresh(id) {
  return { version: 1, sessionId: id, state: 'local', progress: 0, error: null,
    consent: false, requested: false, preparePending: false, origin: null, ownerId: null, storageOrigin: null,
    remoteId: null, fingerprint: null, uploaded: [], retryCount: 0, nextAttemptAt: 0, warnings: [] };
}
function validState(value, id) {
  if (!value || value.version !== 1 || value.sessionId !== id ||
      typeof value.state !== 'string' || !Array.isArray(value.uploaded) ||
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
  async preference() {
    try {
      const value = await readJson(this.settingsPath);
      return { enabled: value?.cloudTranscription === true };
    } catch (error) {
      if (error.code === 'ENOENT') return { enabled: false };
      throw new CallError('settings', 'Transcription preference could not be read.');
    }
  }
  async setPreference(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    const write = this.preferenceWrite.catch(() => {}).then(() =>
      writeJsonWithRetry(this.settingsPath, { version: 1, cloudTranscription: enabled }));
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
