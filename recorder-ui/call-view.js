'use strict';

// One call: title, date, progress, transcript with Find, copy, summary link, delete.
window.createCallView = function createCallView({ api, reportError, onBanner, onBack }) {
  const $ = (id) => document.getElementById(id);
  const el = Object.fromEntries(['call', 'back', 'call-title', 'call-meta', 'call-progress', 'call-progress-fill',
    'call-progress-label', 'call-note', 'call-summary', 'copy-text', 'copy-md', 'find', 'find-count', 'transcript',
    'transcript-empty', 'copy-diagnostics', 'delete-call'].map((id) => [id, $(id)]));
  const format = window.recorderFormat;
  let sessionId = null;
  let view = null;
  let renderedItems = '';
  let request = 0;

  const set = (node, key, value) => { if (node[key] !== value) node[key] = value; };

  function emptyText() {
    if (view.legacy) return 'This older recording has no transcript.';
    if (view.stage === 'recording') return 'The transcript fills in here about a minute behind the call.';
    if (view.stage === 'complete') return 'No speech was detected in this call.';
    if (view.stage === 'publishing' || view.stage === 'transcribing') return 'Transcribing. This usually takes a few minutes.';
    return 'No transcript yet.';
  }

  function renderItems() {
    const key = `${el.find.value}|${JSON.stringify(view.items)}`;
    if (key === renderedItems) return;
    renderedItems = key;
    const matches = window.renderTurns(el.transcript, view.items, { query: el.find.value });
    set(el['find-count'], 'textContent', el.find.value.trim() ? `${matches} found` : '');
    el['transcript-empty'].hidden = view.items.length > 0;
    set(el['transcript-empty'], 'textContent', emptyText());
  }

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
    const hasText = view.items.some((item) => item.kind === 'turn');
    el['copy-text'].disabled = !hasText;
    el['copy-md'].disabled = !hasText;
    el['delete-call'].disabled = !view.canDelete;
    renderItems();
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

  async function copy(button, format) {
    const label = button.textContent;
    try {
      await api.copyTranscript(sessionId, format);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = label; }, 1500);
    } catch (error) { reportError(error); }
  }

  el.back.addEventListener('click', () => onBack());
  el['copy-text'].addEventListener('click', () => copy(el['copy-text'], 'text'));
  el['copy-md'].addEventListener('click', () => copy(el['copy-md'], 'markdown'));
  el.find.addEventListener('input', () => { if (view) renderItems(); });
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
      renderedItems = '';
      el.find.value = '';
      el.transcript.replaceChildren();
      el['call-title'].value = '';
      await refresh();
    },
    close() { sessionId = null; view = null; request += 1; },
    refresh,
    sessionId: () => sessionId,
    retry: () => api.retryCall(sessionId).then(refresh),
  };
};
