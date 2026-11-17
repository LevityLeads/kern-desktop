'use strict';

// One call's status: title, date, Recording / Processing / Ready, progress, and Open in Kern once
// the call has a summary thread. The transcript itself lives in Kern, not here.
window.createCallView = function createCallView({ api, reportError, onBanner, onBack }) {
  const $ = (id) => document.getElementById(id);
  const el = Object.fromEntries(['call', 'back', 'call-title', 'call-meta', 'call-progress', 'call-progress-fill',
    'call-progress-label', 'call-note', 'call-summary', 'copy-diagnostics', 'delete-call'].map((id) => [id, $(id)]));
  const format = window.recorderFormat;
  let sessionId = null;
  let view = null;
  let request = 0;

  const set = (node, key, value) => { if (node[key] !== value) node[key] = value; };

  function render() {
    if (document.activeElement !== el['call-title']) {
      set(el['call-title'], 'value', view.title || format.date(view.startedAtUtc));
    }
    el['call-title'].readOnly = !view.canRename;
    const meta = [format.date(view.startedAtUtc), format.minutes(view.durationMs), view.chip.label];
    set(el['call-meta'], 'textContent', meta.join(' · '));
    el['call-progress'].hidden = !view.progress;
    if (view.progress) {
      el['call-progress-fill'].style.transform = `scaleX(${view.progress.fraction})`;
      set(el['call-progress-label'], 'textContent', view.progress.label);
    }
    el['call-note'].hidden = !view.note;
    set(el['call-note'], 'textContent', view.note || '');
    el['call-summary'].hidden = !view.hasSummary;
    el['delete-call'].disabled = !view.canDelete;
    onBanner(view.banner, sessionId);
  }

  async function refresh() {
    if (!sessionId) return;
    const token = ++request;
    try {
      const next = await api.getCall(sessionId);
      if (token !== request || next.sessionId !== sessionId) return;
      view = next;
      render();
    } catch (error) { if (token === request) reportError(error); }
  }

  el.back.addEventListener('click', () => onBack());
  el['call-summary'].addEventListener('click', () => api.openSummary(sessionId).catch(reportError));
  el['copy-diagnostics'].addEventListener('click', async () => {
    try {
      await api.copyDiagnostics(sessionId);
      el['copy-diagnostics'].textContent = 'Diagnostics copied';
      setTimeout(() => { el['copy-diagnostics'].textContent = 'Copy diagnostics'; }, 1500);
    } catch (error) { reportError(error); }
  });
  el['delete-call'].addEventListener('click', async () => {
    try {
      if ((await api.deleteCall(sessionId)).deleted) onBack();
    } catch (error) { reportError(error); }
  });
  const rename = async () => {
    if (!view?.canRename) return;
    const typed = el['call-title'].value.trim();
    const title = typed && typed !== format.date(view.startedAtUtc) ? typed : null;
    if (title === (view.title || null)) return;
    try { await api.renameCall(sessionId, title); await refresh(); } catch (error) { reportError(error); }
  };
  el['call-title'].addEventListener('change', rename);
  el['call-title'].addEventListener('keydown', (event) => { if (event.key === 'Enter') el['call-title'].blur(); });

  return {
    async open(id) {
      sessionId = id;
      view = null;
      el['call-title'].value = '';
      await refresh();
    },
    close() { sessionId = null; view = null; request += 1; },
    refresh,
    sessionId: () => sessionId,
    retry: () => api.retryCall(sessionId).then(refresh),
  };
};
