'use strict';

// A Kern card (recorder/prompt-card.js). Main decides what an answer does; this page only shows
// the text main passed in the query string, as text, and sends one answer.
(() => {
  const api = window.kernCallPrompt;
  const query = new URLSearchParams(window.location.search);
  const LIMITS = { title: 60, body: 150, primary: 24, secondary: 24 };
  const ELEMENTS = { title: 'prompt-title', body: 'prompt-body', primary: 'prompt-primary', secondary: 'prompt-dismiss' };
  for (const [key, id] of Object.entries(ELEMENTS)) {
    const value = query.get(key);
    if (value) document.getElementById(id).textContent = value.slice(0, LIMITS[key]);
  }
  let answered = false;
  const answer = (choice) => {
    if (answered) return;
    answered = true;
    api.choose(choice);
  };
  document.getElementById('prompt-primary').addEventListener('click', () => answer('primary'));
  document.getElementById('prompt-dismiss').addEventListener('click', () => answer('dismiss'));
  document.getElementById('prompt-close').addEventListener('click', () => answer('dismiss'));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') answer('dismiss'); });
})();
