'use strict';

// Renders conversation items ({ kind: 'turn', speaker, startMs, text } | { kind: 'gap' }) as DOM
// built with textContent only. `query` filters to matching turns and highlights each match.
// Returns the number of matches (0 without a query).
window.renderTurns = function renderTurns(container, items, { query = '' } = {}) {
  const format = window.recorderFormat;
  const needle = query.trim().toLowerCase();
  const labels = { me: 'You', them: 'Them' };
  const fragment = document.createDocumentFragment();
  let matches = 0;

  function highlighted(text) {
    const node = document.createElement('p');
    node.className = 'turn-text';
    if (!needle) { node.textContent = text; return node; }
    const lower = text.toLowerCase();
    let from = 0;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
      if (at > from) node.append(text.slice(from, at));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(at, at + needle.length);
      node.append(mark);
      matches += 1;
      from = at + needle.length;
    }
    if (from < text.length) node.append(text.slice(from));
    return node;
  }

  for (const item of items) {
    if (item.kind === 'gap') {
      if (needle) continue;
      const gap = document.createElement('p');
      gap.className = 'turn-gap';
      gap.textContent = '[a minute of audio could not be transcribed]';
      fragment.append(gap);
      continue;
    }
    if (needle && !item.text.toLowerCase().includes(needle)) continue;
    const turn = document.createElement('article');
    turn.className = `turn ${item.speaker || 'unknown'}`;
    const head = document.createElement('div');
    head.className = 'turn-head';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = labels[item.speaker] || '';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = format.clock(item.startMs);
    head.append(who, time);
    turn.append(head, highlighted(item.text));
    fragment.append(turn);
  }
  container.replaceChildren(fragment);
  return matches;
};
