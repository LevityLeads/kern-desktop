'use strict';

const { isActiveState } = require('./protocol');

// Pure: what the tray says about the recorder. `signature` changes only when the menu itself
// changes, so the menu is rebuilt once per state change, never per status tick.

function clock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function trayTooltip(status) {
  if (status.state === 'recording') return `Kern: recording ${clock(status.elapsedMs)}`;
  if (status.state === 'paused') return `Kern: paused ${clock(status.elapsedMs)}`;
  if (status.state === 'starting') return 'Kern: starting recording';
  if (status.state === 'stopping') return 'Kern: finishing recording';
  return 'Kern';
}

// Menu items as plain descriptors; main.js maps `action` to a function.
function trayItems(status) {
  const items = [{ label: isActiveState(status.state) ? 'Open recorder' : 'Record a call', action: 'show' }];
  const busy = Boolean(status.pending);
  if (status.state === 'recording') items.push({ label: 'Pause recording', action: 'pause', enabled: !busy });
  if (status.state === 'paused') items.push({ label: 'Resume recording', action: 'resume', enabled: !busy });
  if (status.state === 'recording' || status.state === 'paused') items.push({ label: 'Stop recording', action: 'stop', enabled: true });
  if (status.state === 'starting' || status.state === 'stopping') items.push({ label: trayTooltip(status).replace('Kern: ', ''), action: null, enabled: false });
  return items;
}

function traySignature(status) {
  return JSON.stringify(trayItems(status));
}

function isRecordingIcon(status) {
  return status.state === 'recording' || status.state === 'starting';
}

module.exports = { clock, isRecordingIcon, trayItems, traySignature, trayTooltip };
