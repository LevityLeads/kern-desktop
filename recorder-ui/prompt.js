'use strict';

// The "Record this call?" card. Main decides what an answer does (recorder/prompt-card.js);
// this page only shows which app is on the mic and sends one answer.
(() => {
  const api = window.kernCallPrompt;
  const app = new URLSearchParams(window.location.search).get('app');
  if (app) document.getElementById('prompt-app').textContent = app.slice(0, 40);
  let answered = false;
  const answer = (choice) => {
    if (answered) return;
    answered = true;
    api.choose(choice);
  };
  document.getElementById('prompt-record').addEventListener('click', () => answer('record'));
  document.getElementById('prompt-dismiss').addEventListener('click', () => answer('dismiss'));
  document.getElementById('prompt-close').addEventListener('click', () => answer('dismiss'));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') answer('dismiss'); });
})();
