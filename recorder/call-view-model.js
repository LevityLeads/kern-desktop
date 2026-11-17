'use strict';

const { windowCount } = require('./window-cutter');

// Pure: turns stored state into exactly what the recorder window shows. The renderer does no
// interpretation of its own; every label and sentence here is final copy. It carries status only:
// the transcript and summary are read in Kern, so no transcript text ever reaches the window.

function durationMs({ state, session, live }) {
  if (live) return live.elapsedMs;
  if (Number.isSafeInteger(state?.finalFrames)) return state.finalFrames / 16;
  return session ? Math.floor(session.committedFrames / 16) : 0;
}

function expectedWindows(state) {
  return state.cloud.windowCount ?? (Number.isSafeInteger(state.finalFrames) ? windowCount(state.finalFrames / 16) : 0);
}

function chip({ kind, state, damage, live }) {
  if (kind === 'v1') return { kind: 'older', label: 'Older recording' };
  if (live) return { kind: 'recording', label: 'Recording' };
  if (damage) return { kind: 'failed', label: 'Failed' };
  if (!state) return { kind: 'local', label: 'Not transcribed' };
  if (state.error?.retry && !['complete', 'failed'].includes(state.stage)) {
    return { kind: 'waiting', label: state.error.code === 'network' ? 'Waiting for internet' : 'Retrying' };
  }
  switch (state.stage) {
    case 'complete': return { kind: 'ready', label: 'Ready' };
    case 'transcribing': case 'publishing': case 'recording': return { kind: 'working', label: 'Processing' };
    case 'sign-in-required': return { kind: 'attention', label: 'Needs sign-in' };
    case 'failed': return { kind: 'failed', label: 'Failed' };
    case 'empty': return { kind: 'local', label: 'No audio' };
    default: return { kind: 'local', label: 'Not transcribed' };
  }
}

function progress(state, live) {
  if (!state || live) return null;
  if (state.stage === 'publishing') {
    const total = Number.isSafeInteger(state.finalFrames) ? windowCount(state.finalFrames / 16) : 0;
    const uploaded = state.windows.filter(w => w.uploaded).length;
    const remaining = Math.max(0, total - uploaded);
    return {
      label: remaining <= 2 ? 'Finishing: uploading the last minute' : `Finishing: uploading ${remaining} minutes`,
      fraction: total ? uploaded / total : 0,
    };
  }
  if (state.stage === 'transcribing') {
    const total = expectedWindows(state);
    const done = Math.min(total, state.cloud.transcribedWindows ?? 0);
    return { label: `Transcribing ${done}/${total} min`, fraction: total ? done / total : 0 };
  }
  return null;
}

// One sentence, one fix. null when nothing needs the user.
function banner({ state, damage, live }) {
  if (damage) return { message: 'This call\'s saved progress is damaged. Retry rebuilds it from the recording.', action: 'retry' };
  if (!state) return null;
  const error = state.error;
  if (state.stage === 'sign-in-required' || error?.code === 'auth') {
    return { message: live ? 'Sign in to Kern so this call gets transcribed.' : 'Sign in to Kern to finish transcribing this call.', action: 'sign-in' };
  }
  if (state.stage === 'failed') return { message: error?.message || 'This call could not be transcribed.', action: 'retry' };
  if (error?.retry && state.stage !== 'complete') {
    return { message: error.code === 'network' ? 'You\'re offline. Kern keeps trying and picks up where it left off.' : `${error.message} Kern keeps trying.`, action: 'retry' };
  }
  if (state.stage === 'local' && !live) return { message: 'Transcription was off for this call.', action: 'transcribe' };
  return null;
}

function note(state) {
  if (!state) return null;
  if (state.truncated) return 'Only the first four hours of this call were transcribed.';
  if (state.endReason === 'interrupted') return 'Recording ended unexpectedly. Everything up to that point was kept.';
  if (state.stage === 'empty') return 'No audio was recorded in this call.';
  return null;
}

// For the recent-calls list.
function callSummary(input) {
  const { sessionId, kind, state, session, legacy, live } = input;
  return {
    sessionId,
    title: state?.title || null,
    startedAtUtc: session?.startedAtUtc || legacy?.startedAtUtc || null,
    durationMs: kind === 'v1' ? legacy?.durationMs || 0 : durationMs(input),
    chip: chip(input),
    live: Boolean(live),
  };
}

// For the call view: Recording, Processing or Ready, and whether Kern has a thread to open.
function callView(input) {
  const { kind, state, live } = input;
  return {
    ...callSummary(input),
    legacy: kind === 'v1',
    stage: kind === 'v1' ? 'legacy' : live ? 'recording' : state?.stage || 'local',
    progress: progress(state, live),
    banner: kind === 'v1' ? null : banner(input),
    note: kind === 'v1' ? null : note(state),
    hasSummary: Boolean(state?.cloud?.kernThreadUrl),
    canRename: kind !== 'v1' && Boolean(state),
    canDelete: !live,
  };
}

module.exports = { callSummary, callView, chip, progress, banner };
