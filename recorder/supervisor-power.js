'use strict';

const { LIVE_STATES: LIVE, SILENT_LEVELS: SILENT } = require('./helper-status');
const { COMMAND_TIMEOUTS: TIMEOUTS } = require('./liveness');
const { wakeAction } = require('./power-policy');
const { isActiveState } = require('./protocol');

// The recorder across sleep, wake and quit. Functions over a RecorderSupervisor (`sup`), kept
// apart from its command and liveness logic.

// Audio kept after the last status seen before a long sleep: covers the status interval and
// the helper's 1.5 s commit horizon.
const SUSPEND_TAIL_FRAMES = 2 * 16000;

// Lid closed or sleep. Fire and forget: the machine may freeze before any reply arrives.
function onSystemSuspend(sup) {
  sup.suspendedAt = sup.now();
  sup.liveness.suspended = true;
  const helper = sup.helper;
  if (!helper || sup.status.state !== 'recording') return;
  sup.cutAtFrames = sup.status.elapsedMs * 16 + SUSPEND_TAIL_FRAMES;
  sup._set({ pausedBy: 'suspend' });
  helper.request('suspend', sup._controlPayload(), TIMEOUTS.control)
    .then((result) => sup._applyHelperStatus(result)).catch(() => {});
}

async function onSystemResume(sup) {
  const sleptMs = sup.suspendedAt === null ? 0 : sup.now() - sup.suspendedAt;
  sup.suspendedAt = null;
  sup.liveness.suspended = false;
  sup.liveness.reset();
  const action = wakeAction({ pausedBy: sup.status.pausedBy, sleptMs, hasSession: Boolean(sup.helper) && LIVE.has(sup.status.state) });
  if (action === 'resume') {
    sup.cutAtFrames = null;
    // If resume is refused the call stays paused and the window offers Resume.
    await sup._control('resume').catch(() => {});
  } else if (action === 'stop') {
    await sup.stop();
  } else if (sup.status.pausedBy !== 'suspend') {
    sup.cutAtFrames = null;
  }
  return action;
}

// Stops the recording (bounded), then makes sure no helper outlives the app.
async function shutdownForQuit(sup, { timeoutMs = 5000 } = {}) {
  if (sup.helper && LIVE.has(sup.status.state)) {
    let timer;
    await Promise.race([
      sup.stop({ reason: 'application-quit' }),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
  }
  const helper = sup.helper;
  if (helper) { sup._detach(); await helper.terminate(); }
  // The stop was not confirmed in time: the audio on disk is the call, so end it here.
  if (isActiveState(sup.status.state) && sup.status.state !== 'starting') {
    sup._set({ state: 'interrupted', pending: null, levels: SILENT, pausedBy: null });
    sup._sessionEnded(sup.status.sessionId, 'interrupted');
  }
  sup.powerGuard.release();
}

module.exports = { SUSPEND_TAIL_FRAMES, onSystemResume, onSystemSuspend, shutdownForQuit };
