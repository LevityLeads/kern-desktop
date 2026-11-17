'use strict';

const { CallError } = require('./safe-fs');
const { caller } = require('./call-publisher');

// Reading a call back from Kern: its status (GET /api/calls/:id). The transcript itself is read in
// Kern, never here.
const REMOTE_STATES = new Set(['live', 'uploading', 'validating', 'queued', 'transcribing', 'complete', 'failed', 'deleting', 'deleted']);

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

module.exports = { REMOTE_STATES, remoteStatus, threadUrl };
