'use strict';

// Two screens: home (capture card + recent calls) and one call. One banner, owned here, in
// priority order: an error from something the user just did (until dismissed); in the call
// view, that call's banner; at home, a capture problem, then the live call's banner (for
// example "Sign in to Kern so this call gets transcribed").
(() => {
  const api = window.kernRecorder;
  const format = window.recorderFormat;
  const banner = window.createBanner();
  const screens = { home: document.getElementById('home'), call: document.getElementById('call') };
  let screen = 'home';
  let errorBanner = null;
  let captureBanner = null;
  let callBanner = null;
  let liveBanner = null;
  let liveId = null;
  let dismissed = '';
  let lastState = null;
  let lastSessionId = null;

  function reportError(error) {
    errorBanner = { message: format.error(error) };
    renderBanner();
  }

  function runAction(action, sessionId) {
    if (action === 'sign-in') return api.signIn().catch(reportError);
    if (action === 'choose-mic') { home.chooseMic(); dismissed = captureBanner?.message || ''; renderBanner(); return undefined; }
    if (action === 'retry' || action === 'transcribe') {
      return api.retryCall(sessionId).then(() => (screen === 'call' ? callView.refresh() : refreshLive())).catch(reportError);
    }
    return undefined;
  }

  function renderBanner() {
    if (errorBanner) {
      banner.show(errorBanner, { dismiss: () => { errorBanner = null; setTimeout(renderBanner); } });
    } else if (screen === 'call') {
      const sessionId = callView.sessionId();
      banner.show(callBanner, { run: (action) => runAction(action, sessionId) });
    } else if (captureBanner && captureBanner.message !== dismissed) {
      const current = captureBanner;
      banner.show(current, { run: (action) => runAction(action, null), dismiss: () => { dismissed = current.message; setTimeout(renderBanner); } });
    } else {
      banner.show(liveBanner, { run: (action) => runAction(action, liveId) });
    }
  }

  const home = window.createHome({
    api, reportError,
    onCaptureBanner(next) { captureBanner = next; renderBanner(); },
  });
  const callView = window.createCallView({
    api, reportError,
    onBanner(next) { callBanner = next; renderBanner(); },
    onBack: () => show('home'),
  });
  const calls = window.createCallsList({ api, reportError, onOpen: (id) => openCall(id) });

  function show(next) {
    screen = next;
    screens.home.hidden = next !== 'home';
    screens.call.hidden = next !== 'call';
    callBanner = null;
    if (next === 'home') { callView.close(); calls.refresh(); refreshLive(); }
    renderBanner();
    window.scrollTo(0, 0);
  }

  async function openCall(sessionId) {
    show('call');
    await callView.open(sessionId);
  }

  // The call being recorded: its transcript tail and whether it needs the user (sign-in).
  async function refreshLive() {
    const status = home.status();
    const id = ['starting', 'recording', 'paused', 'stopping'].includes(status.state) ? status.sessionId : null;
    liveId = id;
    if (!id) { liveBanner = null; renderBanner(); return; }
    try {
      const view = await api.getCall(id);
      if (liveId !== id) return;
      liveBanner = view.banner;
      home.renderTail(view.items);
    } catch { liveBanner = null; }
    renderBanner();
  }

  api.onStatus((status) => {
    home.renderStatus(status);
    if (status.state === lastState && status.sessionId === lastSessionId) return;
    const ended = ['recording', 'paused', 'stopping'].includes(lastState) && ['stopped', 'interrupted'].includes(status.state);
    lastState = status.state;
    lastSessionId = status.sessionId;
    calls.refresh();
    refreshLive();
    // After Stop, show the call finishing and its transcript arriving.
    if (ended && status.sessionId) openCall(status.sessionId);
  });
  api.onCallsChanged(() => {
    calls.refresh();
    if (screen === 'call') callView.refresh();
    else refreshLive();
  });
  api.onOpenCall(({ sessionId }) => openCall(sessionId));
  window.addEventListener('focus', () => calls.refresh());

  document.getElementById('app-diagnostics').addEventListener('click', () => api.copyDiagnostics(null).catch(reportError));

  (async () => {
    try {
      home.renderStatus(await api.getStatus());
      lastState = home.status().state;
      lastSessionId = home.status().sessionId;
      const setup = await home.load();
      document.getElementById('build').textContent = `Kern ${setup.build}`;
    } catch (error) { reportError(error); }
    calls.refresh();
    refreshLive();
  })();
})();
