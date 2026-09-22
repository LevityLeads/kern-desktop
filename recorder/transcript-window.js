'use strict';

const { isPlainObject } = require('./protocol');
const { CallError } = require('./safe-fs');

// One window's transcript as the server stores it (adapter groq-whisper-v2), or an older shape
// with word `segments`, or plain `text`. Untrusted network (or disk) input: every field is
// checked and bounded before the transcript model sees it.
const SPEAKERS = new Set(['me', 'them']);
const MAX_TEXT = 64 * 1024;
const MAX_ITEMS = 20000;
const MAX_MS = 14_400_000 + 60_000;

function invalid() {
  return new CallError('protocol', 'Kern sent a transcript this app cannot read.');
}

function timed(item) {
  return isPlainObject(item) && Number.isFinite(item.startMs) && Number.isFinite(item.endMs) &&
    item.startMs >= 0 && item.endMs >= item.startMs && item.endMs <= MAX_MS && typeof item.text === 'string' &&
    item.text.length <= MAX_TEXT && (item.speaker === undefined || item.speaker === null || SPEAKERS.has(item.speaker));
}

function items(list) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length > MAX_ITEMS || !list.every(timed)) throw invalid();
  return list.map(item => ({
    speaker: SPEAKERS.has(item.speaker) ? item.speaker : null,
    startMs: Math.round(item.startMs), endMs: Math.round(item.endMs), text: item.text,
  }));
}

// -> { index, text, utterances|null, segments|null, error|null, silent }
function normalizeWindowTranscript(raw, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 240 || !isPlainObject(raw)) throw invalid();
  const text = raw.text === undefined || raw.text === null ? '' : raw.text;
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw invalid();
  if (raw.error !== undefined && raw.error !== null && (typeof raw.error !== 'string' || raw.error.length > 100)) throw invalid();
  return {
    index,
    text,
    utterances: items(raw.utterances),
    segments: raw.utterances ? null : items(raw.segments),
    error: raw.error || null,
    silent: raw.silent === true,
  };
}

// A stored v1 transcript ({ text, segments }) as a single pseudo-window, for older recordings.
function legacyTranscript(raw) {
  if (!isPlainObject(raw)) return null;
  try {
    const text = typeof raw.text === 'string' ? raw.text.slice(0, 1024 * 1024) : '';
    return [{ index: 0, text, utterances: null, segments: items(raw.segments), error: null, silent: false }];
  } catch { return typeof raw.text === 'string' ? [{ index: 0, text: raw.text.slice(0, 1024 * 1024), utterances: null, segments: null, error: null, silent: false }] : null; }
}

module.exports = { normalizeWindowTranscript, legacyTranscript };
