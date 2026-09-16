'use strict';

(() => {
  const api = window.kernRecorder;
  const alert = document.getElementById('alert');
  function reportError(error) {
    alert.textContent = window.recorderFormat.error(error);
    alert.hidden = false;
  }
  const callView = window.createCallView({ api, reportError });
  let library;
  const capture = window.createCaptureView({ api, reportError, onStopped: (id) => library?.refresh(id) });
  library = window.createCallLibrary({ api, callView, reportError, activeSessionId: capture.activeSessionId });
  library.refresh();

  // Preference reads never enqueue anything. Only main's new-call lifecycle owns automation.
  const autoTranscribe = document.getElementById('auto-transcribe');
  let enabled = false;
  api.getTranscriptionEnabled().then((result) => {
    enabled = result.enabled === true;
    autoTranscribe.checked = enabled;
    autoTranscribe.disabled = false;
  }).catch(reportError);
  autoTranscribe.addEventListener('change', async () => {
    const next = autoTranscribe.checked;
    autoTranscribe.disabled = true;
    try {
      const result = await api.setTranscriptionEnabled(next);
      enabled = result.enabled === true;
    } catch (error) { reportError(error); }
    finally { autoTranscribe.checked = enabled; autoTranscribe.disabled = false; }
  });
  window.addEventListener('beforeunload', () => { capture.dispose(); callView.dispose(); });
})();
