'use strict';

// The one banner: one plain sentence and at most one fix button. Text only, never HTML.
window.createBanner = function createBanner() {
  const el = {
    root: document.getElementById('banner'),
    text: document.getElementById('banner-text'),
    action: document.getElementById('banner-action'),
    dismiss: document.getElementById('banner-dismiss'),
  };
  const LABELS = { 'sign-in': 'Sign in', retry: 'Retry', transcribe: 'Transcribe', 'choose-mic': 'Choose another mic' };
  let onAction = null;
  let onDismiss = null;
  let shown = '';

  el.action.addEventListener('click', async () => {
    if (!onAction) return;
    el.action.disabled = true;
    try { await onAction(); } finally { el.action.disabled = false; }
  });
  el.dismiss.addEventListener('click', () => { onDismiss?.(); hide(); });

  function hide() {
    el.root.hidden = true;
    shown = '';
    onAction = null;
    onDismiss = null;
  }

  // banner: { message, action? } ; handlers: { run(action), dismiss? }
  function show(banner, handlers = {}) {
    if (!banner?.message) { hide(); return; }
    const key = `${banner.message}|${banner.action || ''}`;
    onAction = banner.action ? () => handlers.run?.(banner.action) : null;
    onDismiss = handlers.dismiss || null;
    if (key === shown) return;
    shown = key;
    el.text.textContent = banner.message;
    el.action.hidden = !banner.action;
    el.action.textContent = LABELS[banner.action] || '';
    el.dismiss.hidden = !handlers.dismiss;
    el.root.hidden = false;
  }

  return { show, hide };
};
