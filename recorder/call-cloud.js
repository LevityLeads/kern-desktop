'use strict';

const { isPlainObject } = require('./protocol');
const { CallError } = require('./safe-fs');
const { caller } = require('./call-publisher');
const { normalizeWindowTranscript } = require('./transcript-window');

// Reading a call back from Kern: its status (GET /api/calls/:id) and whatever windows are
// transcribed so far (GET /api/calls/:id/transcript, paged).
const REMOTE_STATES = new Set(['live', 'uploading', 'validating', 'queued', 'transcribing', 'complete', 'failed', 'deleting', 'deleted']);
const PAGE = 20;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

function invalid() {
  return new CallError('protocol', 'Kern sent an unexpected response.');
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 240 ? value : null;
}

// Only a Kern thread on the same Kern site may be opened from the recorder.
function threadUrl(value, origin) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

async function remoteStatus(ctx, state) {
  const data = await caller(ctx, state)(`/api/calls/${state.remoteId}`);
  if (!REMOTE_STATES.has(data.state)) throw invalid();
  return {
    state: data.state,
    windowCount: count(data.windowCount),
    transcribedWindows: count(data.transcribedWindows),
    kernThreadUrl: threadUrl(data.kernThreadUrl, state.origin),
  };
}

// Every transcribed window, in index order. Untranscribed windows are simply absent.
async function fetchTranscript(ctx, state) {
  const call = caller(ctx, state);
  const windows = [];
  let after = -1;
  let bytes = 0;
  for (let page = 0; page < Math.ceil(240 / PAGE) + 1; page += 1) {
    const data = await call(`/api/calls/${state.remoteId}/transcript?after=${after}&limit=${PAGE}`);
    if (!Array.isArray(data.windows) || data.windows.length > PAGE) throw invalid();
    for (const item of data.windows) {
      const index = isPlainObject(item) ? (item.window_index ?? item.windowIndex) : undefined;
      if (!Number.isSafeInteger(index) || index <= after || index >= 240) throw invalid();
      after = index;
      if (item.transcript === null || item.transcript === undefined) continue;
      const window = normalizeWindowTranscript(item.transcript, index);
      bytes += JSON.stringify(window).length;
      if (bytes > MAX_TRANSCRIPT_BYTES) throw new CallError('size', 'This transcript is too large to show.');
      windows.push(window);
    }
    if (data.windows.length < PAGE) break;
  }
  return windows;
}

module.exports = { REMOTE_STATES, fetchTranscript, remoteStatus, threadUrl };
