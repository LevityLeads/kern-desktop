'use strict';

// Recent calls, newest first. Re-rendered only when the list actually changed.
window.createCallsList = function createCallsList({ api, onOpen, reportError }) {
  const list = document.getElementById('calls');
  const empty = document.getElementById('calls-empty');
  const format = window.recorderFormat;
  let rendered = '';
  let calls = [];
  let request = 0;

  function row(call) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'call-row';
    button.dataset.sessionId = call.sessionId;
    const name = document.createElement('span');
    name.className = 'call-name';
    name.textContent = call.title || format.date(call.startedAtUtc);
    const meta = document.createElement('span');
    meta.className = 'call-meta';
    meta.textContent = call.title ? `${format.date(call.startedAtUtc)} · ${format.minutes(call.durationMs)}` : format.minutes(call.durationMs);
    const chip = document.createElement('span');
    chip.className = `chip ${call.chip.kind}`;
    chip.textContent = call.chip.label;
    button.append(name, meta, chip);
    item.append(button);
    return item;
  }

  function render() {
    // The live call's duration changes every tick; the list shows it without re-rendering.
    const key = JSON.stringify(calls.map((c) => [c.sessionId, c.title, c.chip, c.live ? 0 : c.durationMs]));
    if (key === rendered) return;
    rendered = key;
    list.replaceChildren(...calls.map(row));
    empty.hidden = calls.length > 0;
  }

  list.addEventListener('click', (event) => {
    const button = event.target.closest('button.call-row');
    if (button) onOpen(button.dataset.sessionId);
  });

  return {
    async refresh() {
      const token = ++request;
      try {
        const next = await api.listCalls();
        if (token !== request) return;
        calls = next;
        render();
      } catch (error) { if (token === request) reportError(error); }
    },
    liveCall: () => calls.find((call) => call.live) || null,
  };
};
