'use strict';

const { spawn } = require('node:child_process');
const { CallError } = require('./call-files');

// A separate helper process never shares capture commands, heartbeats or locks.
function renderCall(helperPath, sessionDir, { signal, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CallError('cancelled', 'Processing paused.')); return; }
    let child;
    try {
      child = spawnProcess(helperPath, ['--render', sessionDir], {
        windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch { reject(new CallError('render-start', 'Audio preparation could not start.')); return; }
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let stderrBytes = 0;
    // Count only. Native error output can contain private paths or captured device names.
    child.stderr?.on('data', chunk => { stderrBytes = Math.min(8192, stderrBytes + chunk.length); });
    const abort = () => { aborted = true; child.kill('SIGKILL'); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 2 * 60 * 60 * 1000);
    timer.unref?.();
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', () => finish(new CallError('render-start', 'Audio preparation could not start.')));
    // close, not exit: all output handles and the helper have finished before artifacts are inspected.
    child.once('close', code => {
      if (aborted) finish(new CallError('cancelled', 'Processing paused.'));
      else if (timedOut) finish(new CallError('render-timeout', 'Audio preparation took too long. Retry it.'));
      else if (code !== 0) finish(new CallError('render-failed', 'Audio preparation failed. Original audio is safe.'));
      else finish();
    });
  });
}
module.exports = { renderCall };
