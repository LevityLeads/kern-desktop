'use strict';

window.createCallView = function createCallView({ api, reportError }) {
  const ids = ['call-panel', 'call-title', 'call-state', 'call-progress', 'call-error', 'call-warnings',
    'call-audio', 'prepare-call', 'export-audio', 'transcribe-call', 'sign-in', 'transcript-text',
    'copy-transcript', 'export-transcript', 'call-diagnostics', 'call-folder'];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const pendingStates = new Set(['pending', 'queued', 'preparing', 'rendering', 'uploading', 'validating', 'transcribing', 'processing', 'retrying', 'loading']);
  let selected = null;
  let generation = 0;
  let timer = null;
  let busy = false;
  let current = null;
  let diagnostics = null;
  let refreshRevision = 0;

  function clearPlayer() {
    el['call-audio'].pause();
    el['call-audio'].removeAttribute('src');
    el['call-audio'].load();
    el['call-audio'].hidden = true;
  }

  function render(call) {
    current = call;
    const state = call.state || 'unknown';
    el['call-state'].textContent = state.replaceAll(/[-_]/g, ' ');
    el['call-progress'].hidden = !pendingStates.has(state);
    if (Number.isFinite(call.progress)) el['call-progress'].value = Math.min(1, Math.max(0, call.progress));
    else el['call-progress'].removeAttribute('value');
    el['call-error'].hidden = !call.error;
    el['call-error'].textContent = call.error ? window.recorderFormat.error(call.error) : '';
    el['call-warnings'].replaceChildren();
    for (const warning of call.warnings || []) {
      const item = document.createElement('li');
      item.textContent = typeof warning === 'string' ? warning : window.recorderFormat.error(warning);
      el['call-warnings'].append(item);
    }
    // Only the main process chooses a local artifact. No renderer-supplied paths.
    const url = typeof call.playbackUrl === 'string' && call.playbackUrl.startsWith('file:') ? call.playbackUrl : null;
    if (url) {
      if (el['call-audio'].getAttribute('src') !== url) el['call-audio'].src = url;
      el['call-audio'].hidden = false;
    } else if (el['call-audio'].getAttribute('src')) clearPlayer();
    const text = call.transcript?.text;
    const hasTranscript = typeof text === 'string';
    const displayText = hasTranscript ? (text || 'No speech detected.') : 'No transcript yet.';
    if (el['transcript-text'].textContent !== displayText) el['transcript-text'].textContent = displayText;
    el['copy-transcript'].disabled = busy || !hasTranscript;
    el['export-transcript'].disabled = busy || !hasTranscript;
    el['export-audio'].disabled = busy || !url;
    el['prepare-call'].hidden = Boolean(url);
    el['prepare-call'].disabled = busy || pendingStates.has(state);
    el['transcribe-call'].disabled = busy || pendingStates.has(state) || hasTranscript;
    el['transcribe-call'].textContent = call.error ? 'Retry transcription' : 'Transcribe';
    el['sign-in'].hidden = !['auth-required', 'sign-in-required', 'needs-auth'].includes(state)
      && !['auth-required', 'unauthorized'].includes(call.error?.code);
    // Diagnostics are text only; transcripts never become HTML or chat commands.
    el['call-diagnostics'].textContent = JSON.stringify({
      state: selected.state, durationMs: selected.durationMs, trackCount: selected.trackCount,
      segmentCount: selected.segmentCount, captureFailure: selected.failure || null,
      processingState: state, progress: call.progress ?? null, error: call.error || null,
      warnings: call.warnings || [],
      tracks: diagnostics?.tracks || [], gaps: diagnostics?.gaps || [],
    }, null, 2);
  }

  function pollLater(token) {
    clearTimeout(timer);
    timer = setTimeout(() => refresh(token), 2000);
  }

  async function refresh(token = generation) {
    if (!selected || token !== generation) return;
    const sessionId = selected.sessionId;
    const revision = ++refreshRevision;
    try {
      const call = await api.getCall(sessionId);
      if (token !== generation || revision !== refreshRevision) return;
      render(call);
    } catch (error) {
      if (token !== generation || revision !== refreshRevision) return;
      el['call-error'].hidden = false;
      el['call-error'].textContent = window.recorderFormat.error(error);
      // A status error cannot clear a working local player or previous transcript.
    } finally { if (token === generation && revision === refreshRevision) pollLater(token); }
  }

  async function action(operation) {
    if (!selected || busy) return;
    const sessionId = selected.sessionId;
    const token = generation;
    busy = true;
    if (current) render(current);
    try { await operation(sessionId); }
    catch (error) { if (token === generation) reportError(error); }
    finally {
      if (token === generation) {
        busy = false;
        if (current) render(current);
        await refresh(token);
      }
    }
  }

  el['prepare-call'].addEventListener('click', () => action((id) => api.prepareCall(id)));
  el['export-audio'].addEventListener('click', () => action((id) => api.exportSession(id)));
  el['transcribe-call'].addEventListener('click', () => action((id) => api.transcribe(id)));
  el['copy-transcript'].addEventListener('click', () => action((id) => api.copyTranscript(id)));
  el['export-transcript'].addEventListener('click', () => action((id) => api.exportTranscript(id)));
  el['call-folder'].addEventListener('click', () => action((id) => api.showInFolder(id)));
  el['sign-in'].addEventListener('click', () => action(() => api.signIn()));
  el['call-audio'].addEventListener('error', () => {
    if (el['call-audio'].getAttribute('src')) {
      el['call-error'].textContent = 'Local audio could not be played. Try preparing the recording again.';
      el['call-error'].hidden = false;
      el['prepare-call'].hidden = false;
      el['prepare-call'].disabled = busy;
    }
  });

  return {
    async select(session) {
      selected = session;
      generation += 1;
      busy = false;
      current = null;
      diagnostics = null;
      clearTimeout(timer);
      clearPlayer();
      el['call-panel'].hidden = false;
      el['call-title'].textContent = session.startedAtUtc ? new Date(session.startedAtUtc).toLocaleString() : 'Recording';
      render({ state: 'loading', transcript: null, warnings: [] });
      el['prepare-call'].disabled = true;
      el['transcribe-call'].disabled = true;
      const token = generation;
      api.getSession(session.sessionId).then((manifest) => {
        if (token !== generation) return;
        diagnostics = manifest;
        if (current) render(current);
      }).catch((error) => { if (token === generation) reportError(error); });
      // Selecting any old call may prepare local audio, but must never upload/transcribe it.
      try { await api.prepareCall(session.sessionId); }
      catch (error) { if (token === generation) reportError(error); }
      await refresh(token);
    },
    selectedId: () => selected?.sessionId,
    dispose() { generation += 1; clearTimeout(timer); clearPlayer(); },
  };
};
