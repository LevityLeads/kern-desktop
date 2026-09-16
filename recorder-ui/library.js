'use strict';
window.createCallLibrary = function createCallLibrary({ api, callView, reportError, activeSessionId }) {
  const container = document.getElementById('sessions');
  const refreshButton = document.getElementById('refresh-sessions');
  let sessions = [];
  let requestId = 0;
  const recovering = new Set();
  function render() {
    container.replaceChildren();
    container.classList.toggle('empty', !sessions.length);
    if (!sessions.length) { container.textContent = 'No recordings yet.'; return; }
    const template = document.getElementById('session-template');
    for (const session of sessions) {
      const node = template.content.cloneNode(true);
      const article = node.querySelector('.session');
      article.dataset.sessionId = session.sessionId;
      node.querySelector('.session-name').textContent = session.startedAtUtc ? new Date(session.startedAtUtc).toLocaleString() : 'Unreadable recording';
      node.querySelector('.session-detail').textContent = [window.recorderFormat.duration(session.durationMs), session.state].join(' · ');
      const select = node.querySelector('[data-action="select"]');
      select.disabled = !['stopped', 'interrupted'].includes(session.state) || !session.segmentCount;
      select.setAttribute('aria-pressed', String(callView.selectedId() === session.sessionId));
      const recover = node.querySelector('[data-action="recover"]');
      recover.hidden = !session.recoverable || session.sessionId === activeSessionId();
      recover.disabled = Boolean(activeSessionId()) || recovering.has(session.sessionId);
      if (session.failure) {
        const failure = document.createElement('p');
        failure.className = 'hint';
        failure.textContent = window.recorderFormat.error(session.failure);
        article.append(failure);
      }
      container.append(node);
    }
  }
  async function refresh(selectId) {
    const token = ++requestId;
    refreshButton.disabled = true;
    try {
      const result = await api.listSessions();
      if (token !== requestId) return;
      sessions = result;
      if (typeof selectId === 'string') {
        const stopped = sessions.find(item => item.sessionId === selectId && item.segmentCount && ['stopped', 'interrupted'].includes(item.state));
        if (stopped) await callView.select(stopped);
      }
      render();
    } catch (error) { if (token === requestId) reportError(error); }
    finally { if (token === requestId) refreshButton.disabled = false; }
  }
  container.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const article = button.closest('.session');
    const session = sessions.find(item => item.sessionId === article.dataset.sessionId);
    if (!session) return;
    try {
      if (button.dataset.action === 'select') {
        const selection = callView.select(session);
        render();
        await selection;
      }
      if (button.dataset.action === 'recover' && !activeSessionId()) {
        recovering.add(session.sessionId);
        render();
        try { await api.recover(session.sessionId); }
        finally { recovering.delete(session.sessionId); await refresh(); }
      }
    } catch (error) { reportError(error); }
  });
  refreshButton.addEventListener('click', () => refresh());
  return { refresh };
};
