'use strict';

const { readJson, writeJsonWithRetry } = require('./atomic-json');

// call-settings.json in userData. Version 2: transcription is on by default and the one-time
// recording notice ("Kern transcribes both sides of calls you record...") is remembered once seen.
// A version-1 file (transcription was opt-in, off by default) migrates to the new default.
// callPrompt: offer to record (a notification, never an automatic start) when a call app takes the mic.
const DEFAULTS = Object.freeze({ enabled: true, noticeAcknowledged: false, callPrompt: true });

class CallSettings {
  constructor(file) {
    this.file = file;
    this.writes = Promise.resolve();
  }

  get() {
    let value;
    try { value = readJson(this.file, { maxBytes: 64 * 1024 }); }
    catch { return { ...DEFAULTS }; }
    if (!value || typeof value !== 'object' || value.version !== 2) return { ...DEFAULTS };
    return {
      enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULTS.enabled,
      noticeAcknowledged: value.noticeAcknowledged === true,
      callPrompt: typeof value.callPrompt === 'boolean' ? value.callPrompt : DEFAULTS.callPrompt,
    };
  }

  // Serialised so two quick toggles never interleave their read-modify-write.
  update(patch) {
    const write = this.writes.catch(() => {}).then(async () => {
      const next = { ...this.get(), ...patch };
      await writeJsonWithRetry(this.file, {
        version: 2, enabled: next.enabled, noticeAcknowledged: next.noticeAcknowledged, callPrompt: next.callPrompt,
      });
      return next;
    });
    this.writes = write;
    return write;
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    return this.update({ enabled });
  }

  setCallPrompt(callPrompt) {
    if (typeof callPrompt !== 'boolean') throw new TypeError('callPrompt must be boolean');
    return this.update({ callPrompt });
  }

  acknowledgeNotice() {
    return this.update({ noticeAcknowledged: true });
  }
}

module.exports = { CallSettings, DEFAULTS };
