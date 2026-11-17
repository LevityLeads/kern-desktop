'use strict';

const { readJson, writeJson } = require('./atomic-json');
const { validateMicrophoneSelection } = require('./protocol');

class MicrophonePreference {
  constructor(file) { this.file = file; }

  get() {
    try {
      const value = readJson(this.file);
      if (value === null) return { mode: 'default' };
      if (value.version !== 1) throw new Error('Unsupported preference');
      return validateMicrophoneSelection(value.microphone);
    } catch {
      throw new Error('Saved microphone could not be read. Select your microphone again.');
    }
  }

  set(selection) {
    const microphone = validateMicrophoneSelection(selection);
    try { writeJson(this.file, { version: 1, microphone }); }
    catch { throw new Error('Microphone choice could not be saved.'); }
    return microphone;
  }
}

module.exports = { MicrophonePreference };
