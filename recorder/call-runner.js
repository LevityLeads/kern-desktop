'use strict';

const catalog = require('./session-catalog');
const { CallError } = require('./safe-fs');
const { caller, ensureRemote, finalize, publishFinal, publishLive } = require('./call-publisher');
const { fetchTranscript, remoteStatus } = require('./call-cloud');
const { finalDuration } = require('./window-cutter');

// One pass of the call pipeline for one call. Each pass does whatever the call needs next and
// returns the delay until the next pass (or null when the call needs nothing more). Errors
// propagate; the pipeline classifies them and schedules the retry.
const LIVE_INTERVAL_MS = 5000;
const POLL_INTERVAL_MS = 5000;
const DELETE_RETRY_MS = 60000;
// Kern posts its summary thread a little after the transcript; keep looking for a while.
const SUMMARY_POLL_MS = 60000;
const SUMMARY_WAIT_MS = 30 * 60000;
const GONE = new Set(['deleting', 'deleted']);
const PUBLISHABLE = new Set(['live', 'uploading']);

async function setStage(ctx, state, stage) {
  if (state.stage === stage) return;
  state.stage = stage;
  await ctx.save(state);
}

// Fixes the call's final length once, from the audio actually on disk. `cutAtFrames` trims a
// call that was stopped after a long sleep back to the moment the machine went to sleep.
async function settleEnd(ctx, state, cutAtFrames = null) {
  if (state.finalFrames !== null) return;
  const session = await catalog.readSession(ctx.root, state.sessionId);
  const frames = (await catalog.audioFrames(ctx.root, state.sessionId)) ?? 0;
  const limit = Number.isSafeInteger(cutAtFrames) && cutAtFrames >= 0 ? cutAtFrames : Infinity;
  const { durationMs, truncated } = finalDuration(Math.min(frames, limit));
  state.finalFrames = durationMs * 16;
  state.truncated = truncated;
  state.endReason = session?.state === 'stopped' ? 'stopped' : 'interrupted';
  await ctx.save(state);
}

// The transcript is stored before a byte of audio is removed. A failed delete retries later.
async function deleteAudio(ctx, state) {
  try {
    await catalog.deleteAudio(ctx.root, state.sessionId);
  } catch {
    return DELETE_RETRY_MS;
  }
  state.audioDeleted = true;
  await ctx.save(state);
  return null;
}

// Best effort, never an error: a complete call stays complete whatever happens here.
async function awaitSummary(ctx, state) {
  if (state.cloud.kernThreadUrl || !state.remoteId) return null;
  if (!(ctx.now() - Date.parse(state.completedAt) < SUMMARY_WAIT_MS)) return null;
  try {
    const remote = await remoteStatus(ctx, state);
    if (remote.kernThreadUrl) {
      state.cloud = remote;
      await ctx.save(state);
      return null;
    }
  } catch { /* try again on the next poll */ }
  return SUMMARY_POLL_MS;
}

async function complete(ctx, state) {
  state.transcript = { windows: await fetchTranscript(ctx, state) };
  state.stage = 'complete';
  state.completedAt = new Date(ctx.now()).toISOString();
  state.error = null;
  await ctx.save(state);
  ctx.onComplete(state);
  return (await deleteAudio(ctx, state)) ?? awaitSummary(ctx, state);
}

async function runCall(ctx, state) {
  if (state.stage === 'complete') return (state.audioDeleted ? null : await deleteAudio(ctx, state)) ?? awaitSummary(ctx, state);
  if (state.stage === 'empty') return null;
  const live = ctx.live(state.sessionId);
  // A call that is not being captured has ended, whatever its session.json says (a crash or a
  // quit mid-call leaves "recording" there): fix its length from the file before anything else.
  if (!live) await settleEnd(ctx, state);
  if (!state.transcribe) {
    await setStage(ctx, state, 'local');
    return null;
  }

  if (live) {
    await setStage(ctx, state, 'recording');
    await ensureRemote(ctx, state);
    await publishLive(ctx, state, live.committedFrames);
    return LIVE_INTERVAL_MS;
  }

  if (state.finalFrames === 0) {
    if (state.remoteId) await caller(ctx, state)(`/api/calls/${state.remoteId}`, { method: 'DELETE' }).catch(() => {});
    await setStage(ctx, state, 'empty');
    return null;
  }

  if (!state.finalized) {
    await setStage(ctx, state, 'publishing');
    await ensureRemote(ctx, state);
    const remote = await remoteStatus(ctx, state);
    if (GONE.has(remote.state)) throw new CallError('remote-deleted', 'This call was deleted in Kern.');
    if (PUBLISHABLE.has(remote.state)) {
      await publishFinal(ctx, state);
      await finalize(ctx, state);
    } else {
      // Finalized already; the acknowledgement was lost before it was saved.
      state.finalized = true;
      await ctx.save(state);
    }
  }

  const remote = await remoteStatus(ctx, state);
  const changed = JSON.stringify(remote) !== JSON.stringify(state.cloud);
  state.cloud = remote;
  if (GONE.has(remote.state)) throw new CallError('remote-deleted', 'This call was deleted in Kern.');
  if (remote.state === 'failed') {
    state.cloudFailed = true;
    await ctx.save(state);
    throw new CallError('cloud-failed', 'Kern could not transcribe this call.');
  }
  if (remote.state === 'complete') return complete(ctx, state);
  if (changed || state.stage !== 'transcribing') {
    state.stage = 'transcribing';
    await ctx.save(state);
  }
  return POLL_INTERVAL_MS;
}

module.exports = { LIVE_INTERVAL_MS, POLL_INTERVAL_MS, runCall, settleEnd };
