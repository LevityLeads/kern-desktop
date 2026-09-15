'use strict';

const recorder = window.kernRecorder;
const elements = {
  alert: document.getElementById('alert'),
  consent: document.getElementById('consent'),
  disk: document.getElementById('disk'),
  microphone: document.getElementById('microphone'),
  mute: document.getElementById('mute'),
  pause: document.getElementById('pause'),
  refreshDevices: document.getElementById('refresh-devices'),
  refreshSessions: document.getElementById('refresh-sessions'),
  sessions: document.getElementById('sessions'),
  start: document.getElementById('start'),
  state: document.getElementById('state'),
  statusCopy: document.getElementById('status-copy'),
  stop: document.getElementById('stop'),
  timer: document.getElementById('timer'),
  tracks: document.getElementById('tracks'),
};

let currentStatus = { state: 'idle', micMuted: false, tracks: [] };
let timerHandle = null;

function showError(error) {
  elements.alert.textContent = error?.message || String(error);
  elements.alert.hidden = false;
}

function clearError() {
  elements.alert.hidden = true;
  elements.alert.textContent = '';
}

async function run(action) {
  clearError();
  try {
    return await action();
  } catch (error) {
    showError(error);
    throw error;
  }
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Disk space unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function isBusy(state) {
  return ['starting', 'pausing', 'muting', 'unmuting', 'resuming', 'stopping'].includes(state);
}

function isActive(state) {
  return ['starting', 'recording', 'pausing', 'paused', 'muting', 'unmuting', 'resuming', 'stopping', 'degraded', 'suspended'].includes(state);
}

function renderStatus(status) {
  currentStatus = status || currentStatus;
  const state = currentStatus.state || 'unknown';
  elements.state.textContent = state.replaceAll('-', ' ');
  elements.state.className = `state ${state}`;
  const active = isActive(state);
  const pending = isBusy(state);
  elements.start.disabled = active || !elements.consent.checked;
  elements.microphone.disabled = active;
  elements.pause.disabled = !active || pending || state === 'stopping' || state === 'suspended';
  elements.pause.textContent = state === 'paused' ? 'Resume' : 'Pause';
  elements.mute.disabled = !active || pending || state === 'stopping' || state === 'suspended';
  elements.mute.textContent = currentStatus.micMuted ? 'Unmute Kern mic' : 'Mute Kern mic';
  elements.stop.disabled = !active || state === 'stopping';
  elements.disk.textContent = currentStatus.freeBytes == null
    ? 'Disk space unknown'
    : `${formatBytes(currentStatus.freeBytes)} free`;

  if (currentStatus.failure) showError(currentStatus.failure);
  const pendingCopy = pending ? `${state.replaceAll('-', ' ')}. Waiting for capture acknowledgement.` : null;
  elements.statusCopy.textContent = pendingCopy || currentStatus.message ||
    (active ? 'Kern mute is separate from Teams mute.' : 'Ready. Files stay local and work offline.');

  renderTracks(currentStatus.tracks || []);
  updateTimer();
  if (active && !timerHandle) timerHandle = setInterval(updateTimer, 250);
  if (!active && timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
    loadSessions();
  }
}

function updateTimer() {
  let elapsed = currentStatus.effectiveElapsedMs || 0;
  if (currentStatus.startedAtUtc && isActive(currentStatus.state) && currentStatus.state !== 'paused') {
    elapsed = Math.max(elapsed, Date.now() - Date.parse(currentStatus.startedAtUtc));
  }
  elements.timer.textContent = formatDuration(elapsed);
}

function renderTracks(tracks) {
  elements.tracks.replaceChildren();
  elements.tracks.classList.toggle('empty', tracks.length === 0);
  if (tracks.length === 0) {
    elements.tracks.textContent = 'No active tracks.';
    return;
  }

  const template = document.getElementById('track-template');
  for (const track of tracks) {
    const node = template.content.cloneNode(true);
    node.querySelector('.track-name').textContent = track.name || track.trackId;
    node.querySelector('.track-health').textContent = String(track.health || 'unknown').replaceAll('-', ' ');
    node.querySelector('.track-meter').value = Number.isFinite(track.peak) ? track.peak : 0;
    const detail = [];
    if (track.defaultRoles?.length) detail.push(track.defaultRoles.join(', '));
    if (track.droppedFrames) detail.push(`${track.droppedFrames} dropped`);
    if (track.message) detail.push(track.message);
    node.querySelector('.track-detail').textContent = detail.join(' · ');
    elements.tracks.append(node);
  }
}

async function loadDevices() {
  elements.refreshDevices.disabled = true;
  try {
    const result = await run(() => recorder.listDevices());
    const microphones = result.captureEndpoints || [];
    const previous = elements.microphone.value;
    elements.microphone.replaceChildren(new Option('Default microphone, pinned when recording starts', 'default'));
    for (const microphone of microphones) {
      const option = new Option(microphone.name, `device:${microphone.id}`);
      option.disabled = microphone.supported === false;
      elements.microphone.add(option);
    }
    if ([...elements.microphone.options].some((option) => option.value === previous)) {
      elements.microphone.value = previous;
    }
  } finally {
    elements.refreshDevices.disabled = false;
    elements.microphone.disabled = isActive(currentStatus.state);
  }
}

async function loadSessions() {
  elements.refreshSessions.disabled = true;
  try {
    const sessions = await run(() => recorder.listSessions());
    renderSessions(sessions);
  } finally {
    elements.refreshSessions.disabled = false;
  }
}

function renderSessions(sessions) {
  elements.sessions.replaceChildren();
  elements.sessions.classList.toggle('empty', sessions.length === 0);
  if (sessions.length === 0) {
    elements.sessions.textContent = 'No recordings yet.';
    return;
  }

  const template = document.getElementById('session-template');
  for (const session of sessions) {
    const node = template.content.cloneNode(true);
    const article = node.querySelector('.session');
    article.dataset.sessionId = session.sessionId;
    const date = session.startedAtUtc ? new Date(session.startedAtUtc).toLocaleString() : session.sessionId;
    node.querySelector('.session-name').textContent = `${date} · ${session.state}`;
    node.querySelector('.session-detail').textContent = [
      formatDuration(session.durationMs || 0),
      formatBytes(session.sizeBytes || 0),
      `${session.trackCount || 0} tracks`,
      `${session.segmentCount || 0} segments`,
    ].join(' · ');
    node.querySelector('[data-action="play"]').disabled = !session.segmentCount;
    node.querySelector('[data-action="recover"]').hidden = !session.recoverable;
    elements.sessions.append(node);
  }
}

async function playSession(article) {
  const sessionId = article.dataset.sessionId;
  const manifest = await run(() => recorder.getSession(sessionId));
  const players = article.querySelector('.players');
  players.replaceChildren();
  for (const track of manifest.tracks || []) {
    const segments = (manifest.segments || [])
      .filter((candidate) => candidate.trackId === track.trackId && candidate.status === 'finalised')
      .sort((left, right) => left.sequence - right.sequence);
    if (!segments.length) continue;
    const urls = await Promise.all(segments.map((segment) =>
      recorder.playbackUrl(sessionId, track.trackId, segment.segmentId)
    ));
    const label = document.createElement('span');
    label.className = 'session-detail';
    label.textContent = `${track.name}: ${segments.length} durable segment${segments.length === 1 ? '' : 's'}`;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    let segmentIndex = 0;
    audio.src = urls[segmentIndex];
    audio.addEventListener('ended', () => {
      segmentIndex += 1;
      if (segmentIndex >= urls.length) {
        segmentIndex = 0;
        audio.src = urls[segmentIndex];
        return;
      }
      audio.src = urls[segmentIndex];
      audio.play().catch(showError);
    });
    players.append(label, audio);
  }
}

elements.start.addEventListener('click', () => run(async () => {
  const selected = elements.microphone.value;
  const microphone = selected.startsWith('device:')
    ? { mode: 'device', deviceId: selected.slice('device:'.length) }
    : { mode: 'default' };
  renderStatus(await recorder.start(microphone));
}));

elements.pause.addEventListener('click', () => run(async () => {
  const status = currentStatus.state === 'paused' ? await recorder.resume() : await recorder.pause();
  renderStatus(status);
}));

elements.mute.addEventListener('click', () => run(async () => {
  renderStatus(await recorder.setMicMuted(!currentStatus.micMuted));
}));

elements.stop.addEventListener('click', () => run(async () => {
  renderStatus(await recorder.stop());
  await loadSessions();
}));

elements.consent.addEventListener('change', () => renderStatus(currentStatus));
elements.refreshDevices.addEventListener('click', loadDevices);
elements.refreshSessions.addEventListener('click', loadSessions);
elements.sessions.addEventListener('click', (event) => run(async () => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const article = button.closest('.session');
  const sessionId = article.dataset.sessionId;
  if (button.dataset.action === 'play') await playSession(article);
  if (button.dataset.action === 'export') await recorder.exportSession(sessionId);
  if (button.dataset.action === 'folder') await recorder.showInFolder(sessionId);
  if (button.dataset.action === 'recover') {
    await recorder.recover(sessionId);
    await loadSessions();
  }
}));

recorder.onStatus(renderStatus);
renderStatus(currentStatus);
loadDevices().catch(() => {});
loadSessions().catch(() => {});
