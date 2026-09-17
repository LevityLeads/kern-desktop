'use strict';

window.createCaptureView = function createCaptureView({ api, reportError, onStopped }) {
  const byId = (id) => document.getElementById(id);
  const el = Object.fromEntries(['state', 'start', 'stop', 'pause', 'mute', 'microphone', 'consent',
    'disk', 'timer', 'tracks', 'status-copy', 'refresh-devices'].map((id) => [id, byId(id)]));
  const activeStates = new Set(['starting', 'recording', 'pausing', 'paused', 'muting', 'unmuting',
    'resuming', 'stopping', 'degraded', 'suspended']);
  const pendingStates = new Set(['starting', 'pausing', 'muting', 'unmuting', 'resuming', 'stopping']);
  let status = { state: 'idle', micMuted: false, tracks: [] };
  let timer = null;
  let commandPending = false;
  let hydrated = false;
  let statusRevision = 0;
  let receivedAt = Date.now();
  let microphone = { mode: 'default' };
  let preferenceReady = false;
  let preferenceLoading = true;
  let devicesReady = false;
  let devicesPending = false;
  let savingMicrophone = false;
  let captureEndpoints = [];

  function microphoneAvailable() {
    return captureEndpoints.some(endpoint => endpoint.supported !== false &&
      (microphone.mode === 'device' ? endpoint.id === microphone.deviceId
        : endpoint.defaultRoles?.includes('communications')));
  }

  function renderMicrophones() {
    el.microphone.replaceChildren(new Option('Windows default communications microphone', 'default'));
    for (const endpoint of captureEndpoints) {
      const option = new Option(endpoint.name, `device:${endpoint.id}`);
      option.disabled = endpoint.supported === false;
      el.microphone.add(option);
    }
    if (microphone.mode === 'device' && !captureEndpoints.some(e => e.id === microphone.deviceId)) {
      const missing = new Option('Selected microphone unavailable. Reconnect it or choose another.', `device:${microphone.deviceId}`);
      missing.disabled = true;
      el.microphone.add(missing);
    }
    el.microphone.value = microphone.mode === 'device' ? `device:${microphone.deviceId}` : 'default';
  }

  function updateTimer() {
    const running = ['recording', 'degraded'].includes(status.state);
    const elapsed = (status.effectiveElapsedMs || 0) + (running ? Date.now() - receivedAt : 0);
    el.timer.textContent = window.recorderFormat.duration(elapsed);
  }

  function renderTracks(tracks) {
    el.tracks.replaceChildren();
    el.tracks.classList.toggle('empty', tracks.length === 0);
    if (!tracks.length) { el.tracks.textContent = 'No active devices.'; return; }
    const template = byId('track-template');
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
      el.tracks.append(node);
    }
  }

  function renderControls() {
    const state = status.state || 'unknown';
    const active = activeStates.has(state);
    const pending = commandPending || pendingStates.has(state);
    el.state.textContent = state.replaceAll('-', ' ');
    el.state.className = `state ${state}`;
    el.start.disabled = !hydrated || active || pending || !el.consent.checked ||
      !preferenceReady || !devicesReady || devicesPending || savingMicrophone || !microphoneAvailable();
    el.microphone.disabled = active || pending || preferenceLoading || devicesPending || savingMicrophone;
    el['refresh-devices'].disabled = active || pending || preferenceLoading || devicesPending || savingMicrophone;
    el.pause.disabled = !active || pending || state === 'suspended';
    el.pause.textContent = state === 'paused' ? 'Resume' : 'Pause';
    el.mute.disabled = !active || pending || state === 'suspended';
    el.mute.textContent = status.micMuted ? 'Unmute Kern mic' : 'Mute Kern mic';
    // A pending command must never remove the Stop escape hatch.
    el.stop.disabled = !active || state === 'stopping';
    el.disk.textContent = status.freeBytes == null ? 'Disk space unknown' : `${window.recorderFormat.bytes(status.freeBytes)} free`;
    el['status-copy'].textContent = pendingStates.has(state)
      ? `${state.replaceAll('-', ' ')}. Waiting for capture acknowledgement.`
      : status.message || (active ? 'Kern mute is separate from Teams mute.' : 'Ready. Recording works offline. Originals stay local.');
  }

  function renderStatus(next) {
    const wasActive = activeStates.has(status.state);
    status = next || status;
    receivedAt = Date.now();
    renderControls();
    renderTracks(status.tracks || []);
    if (status.failure) reportError(status.failure);
    updateTimer();
    const active = activeStates.has(status.state);
    if (active && !timer) timer = setInterval(updateTimer, 250);
    if (!active && timer) { clearInterval(timer); timer = null; }
    if (wasActive && !active) onStopped(status.sessionId);
  }

  async function command(action) {
    commandPending = true;
    renderControls();
    try { renderStatus(await action()); }
    catch (error) { reportError(error); }
    finally { commandPending = false; renderControls(); }
  }

  async function loadDevices() {
    if (preferenceLoading || devicesPending || commandPending || activeStates.has(status.state)) return;
    devicesPending = true;
    devicesReady = false;
    renderControls();
    try {
      const result = await api.listDevices();
      captureEndpoints = result.captureEndpoints || [];
      devicesReady = true;
      renderMicrophones();
    } catch (error) { reportError(error); }
    finally { devicesPending = false; renderControls(); }
  }

  el.microphone.addEventListener('change', async () => {
    const selected = el.microphone.value;
    const choice = selected.startsWith('device:')
      ? { mode: 'device', deviceId: selected.slice(7) } : { mode: 'default' };
    savingMicrophone = true;
    preferenceReady = false;
    renderControls();
    try {
      microphone = await api.setMicrophone(choice);
      preferenceReady = true;
    } catch (error) { reportError(error); }
    finally { savingMicrophone = false; renderMicrophones(); renderControls(); }
  });
  el.start.addEventListener('click', () => {
    if (el.start.disabled) return;
    return command(() => api.start(microphone));
  });
  el.pause.addEventListener('click', () => command(() => status.state === 'paused' ? api.resume() : api.pause()));
  el.mute.addEventListener('click', () => command(() => api.setMicMuted(!status.micMuted)));
  el.stop.addEventListener('click', () => command(() => api.stop()));
  el.consent.addEventListener('change', renderControls);
  el['refresh-devices'].addEventListener('click', loadDevices);
  const unsubscribe = api.onStatus((next) => {
    statusRevision += 1;
    hydrated = true;
    renderStatus(next);
  });
  renderStatus(status);
  const revision = statusRevision;
  api.getStatus().then((snapshot) => {
    if (revision === statusRevision) { hydrated = true; renderStatus(snapshot); }
  }).catch(reportError);
  api.getMicrophone().then(selection => {
    microphone = selection;
    preferenceReady = true;
    renderMicrophones();
  }).catch(reportError).finally(() => { preferenceLoading = false; renderControls(); loadDevices(); });
  return {
    activeSessionId: () => activeStates.has(status.state) ? status.sessionId : null,
    dispose() { unsubscribe(); if (timer) clearInterval(timer); },
  };
};
