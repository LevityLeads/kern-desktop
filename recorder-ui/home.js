'use strict';

// The capture card: one Start button when idle; timer, levels, Stop/Mute/Pause and the live
// transcript tail while recording. Status arrives twice a second; only text and bar widths
// that actually changed are touched.
window.createHome = function createHome({ api, reportError, onCaptureBanner }) {
  const $ = (id) => document.getElementById(id);
  const el = Object.fromEntries(['idle', 'recording', 'start', 'mic-name', 'mic-change', 'mic-picker', 'mic-select',
    'transcription-state', 'transcription-toggle', 'notice', 'notice-ok', 'timer', 'rec-state', 'rec-dot', 'level-me',
    'level-them', 'them-hint', 'rec-warning', 'stop', 'mute', 'pause', 'tail', 'tail-empty'].map((id) => [id, $(id)]));
  const format = window.recorderFormat;
  const ACTIVE = new Set(['starting', 'recording', 'paused', 'stopping']);
  const THEM_SILENCE_HINT_MS = 60000;
  let status = { state: 'idle', levels: { me: 0, them: 0 } };
  let receivedAt = Date.now();
  let setup = null;
  let devices = [];
  let busy = false;
  let themSilentSince = null;
  let ticker = null;

  const set = (node, key, value) => { if (node[key] !== value) node[key] = value; };

  function micLabel() {
    const mic = setup?.microphone || { mode: 'default' };
    if (mic.mode === 'device') return devices.find((d) => d.id === mic.deviceId)?.name || 'Saved microphone (not connected)';
    const fallback = devices.find((d) => d.defaultRoles?.includes('communications'));
    return fallback ? `Windows default (${fallback.name})` : 'Windows default';
  }

  function renderSetup() {
    if (!setup) return;
    set(el['mic-name'], 'textContent', micLabel());
    const on = setup.transcription.enabled;
    set(el['transcription-state'], 'textContent', on ? 'on' : 'off');
    set(el['transcription-toggle'], 'textContent', on ? 'turn off' : 'turn on');
    el.start.disabled = busy || ACTIVE.has(status.state);
  }

  function renderMicPicker() {
    const options = [new Option('Windows default', 'default')];
    for (const device of devices) {
      const option = new Option(device.name, `device:${device.id}`);
      option.disabled = device.supported === false;
      options.push(option);
    }
    el['mic-select'].replaceChildren(...options);
    const mic = setup?.microphone;
    el['mic-select'].value = mic?.mode === 'device' ? `device:${mic.deviceId}` : 'default';
  }

  function tick() {
    const running = status.state === 'recording';
    set(el.timer, 'textContent', format.clock((status.elapsedMs || 0) + (running ? Date.now() - receivedAt : 0)));
  }

  function renderStatus(next) {
    const previous = status;
    status = next;
    receivedAt = Date.now();
    const active = ACTIVE.has(status.state);
    set(el.idle, 'hidden', active);
    set(el.recording, 'hidden', !active);
    renderSetup();
    if (!active) {
      clearInterval(ticker); ticker = null; themSilentSince = null;
      onCaptureBanner(status.failure ? {
        message: previous.state === 'starting' || status.state === 'idle'
          ? `Recording could not start. ${status.failure.message}` : `Recording stopped. ${status.failure.message} Everything up to that point is saved.`,
        action: status.state === 'idle' ? 'choose-mic' : null,
      } : null);
      return;
    }
    onCaptureBanner(null);
    if (!ticker) ticker = setInterval(tick, 1000);
    tick();
    const labels = { starting: 'Starting', paused: status.pausedBy === 'suspend' ? 'Paused while asleep' : 'Paused', stopping: 'Finishing' };
    set(el['rec-state'], 'textContent', labels[status.state] || '');
    el['rec-dot'].classList.toggle('live', status.state === 'recording');
    el['level-me'].style.transform = `scaleX(${status.levels?.me || 0})`;
    el['level-them'].style.transform = `scaleX(${status.levels?.them || 0})`;
    if (status.state === 'recording' && !(status.levels?.them > 0)) themSilentSince ??= Date.now();
    else if (status.levels?.them > 0) themSilentSince = null;
    set(el['them-hint'], 'hidden', !(themSilentSince && Date.now() - themSilentSince >= THEM_SILENCE_HINT_MS));
    set(el['rec-warning'], 'hidden', !status.warning);
    set(el['rec-warning'], 'textContent', status.warning || '');
    const pending = Boolean(status.pending) || status.state === 'starting' || status.state === 'stopping';
    el.stop.disabled = status.state === 'stopping' || status.state === 'starting';
    el.mute.disabled = pending;
    el.pause.disabled = pending;
    set(el.mute, 'textContent', status.micMuted ? 'Unmute' : 'Mute');
    set(el.pause, 'textContent', status.state === 'paused' ? 'Resume' : 'Pause');
  }

  async function run(action) {
    try { await action(); } catch (error) { reportError(error); }
  }

  async function start() {
    busy = true; renderSetup();
    try { await api.start(); } catch (error) { reportError(error); } finally { busy = false; renderSetup(); }
  }

  async function loadDevices() {
    try {
      devices = (await api.listDevices()).captureEndpoints || [];
    } catch { devices = []; }
    renderSetup();
    renderMicPicker();
  }

  el.start.addEventListener('click', () => {
    if (!setup?.transcription.noticeAcknowledged) { el.notice.hidden = false; el['notice-ok'].focus(); return; }
    start();
  });
  el['notice-ok'].addEventListener('click', () => run(async () => {
    setup.transcription = await api.acknowledgeNotice();
    el.notice.hidden = true;
    await start();
  }));
  el['mic-change'].addEventListener('click', () => {
    el['mic-picker'].hidden = !el['mic-picker'].hidden;
    if (!el['mic-picker'].hidden) loadDevices();
  });
  el['mic-select'].addEventListener('change', () => run(async () => {
    const value = el['mic-select'].value;
    setup.microphone = await api.setMicrophone(value.startsWith('device:') ? { mode: 'device', deviceId: value.slice(7) } : { mode: 'default' });
    el['mic-picker'].hidden = true;
    renderSetup();
  }));
  el['transcription-toggle'].addEventListener('click', () => run(async () => {
    setup.transcription = await api.setTranscription(!setup.transcription.enabled);
    renderSetup();
  }));
  el.stop.addEventListener('click', () => run(() => api.stop()));
  el.mute.addEventListener('click', () => run(() => api.setMicMuted(!status.micMuted)));
  el.pause.addEventListener('click', () => run(() => (status.state === 'paused' ? api.resume() : api.pause())));

  return {
    async load() {
      setup = await api.getSetup();
      renderSetup();
      if (!ACTIVE.has(status.state)) loadDevices();
      return setup;
    },
    renderStatus,
    renderTail(items) {
      window.renderTurns(el.tail, items.slice(-6));
      set(el['tail-empty'], 'hidden', items.length > 0);
    },
    chooseMic() { el['mic-picker'].hidden = false; loadDevices(); el['mic-select'].focus(); },
    status: () => status,
  };
};
