'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { IPC } = require('./protocol');
const { registerRecorderIpc } = require('./ipc');
const { createRecorderWindow } = require('./window');

// The recorder window and the handlers behind its IPC. Validation happens in ipc.js before any
// handler runs; handlers only ever receive validated payloads.
class RecorderController {
  constructor({ BrowserWindow, ipcMain, dialog, clipboard, appRoot, getParentWindow,
    supervisor, pipeline, service, settings, microphones, signIn, openKernUrl }) {
    Object.assign(this, { BrowserWindow, dialog, clipboard, appRoot, getParentWindow, supervisor, pipeline,
      service, settings, microphones, signIn, openKernUrl });
    this.window = null;
    this.pendingOpen = null;
    this.ipc = registerRecorderIpc({
      ipcMain,
      getRecorderWindow: () => this.window,
      trustedRecorderUrl: pathToFileURL(path.join(appRoot, 'recorder-ui', 'index.html')).href,
      handlers: this.handlers(),
    });
  }

  handlers() {
    const { supervisor, pipeline, service, settings, clipboard } = this;
    return {
      [IPC.GET_STATUS]: () => supervisor.snapshot(),
      [IPC.GET_SETUP]: () => ({ microphone: this.microphone(), transcription: settings.get(), build: supervisor.build }),
      [IPC.LIST_DEVICES]: () => supervisor.listDevices(),
      [IPC.SET_MICROPHONE]: (selection) => this.microphones.set(selection),
      [IPC.SET_TRANSCRIPTION]: ({ enabled }) => settings.setEnabled(enabled),
      [IPC.SET_CALL_PROMPT]: ({ enabled }) => settings.setCallPrompt(enabled),
      [IPC.ACKNOWLEDGE_NOTICE]: () => settings.acknowledgeNotice(),
      [IPC.START]: () => this.start(),
      [IPC.PAUSE]: () => supervisor.pause(),
      [IPC.RESUME]: () => supervisor.resume(),
      [IPC.SET_MIC_MUTED]: ({ muted }) => supervisor.setMicMuted(muted),
      [IPC.STOP]: () => supervisor.stop(),
      [IPC.LIST_CALLS]: () => service.list(),
      [IPC.GET_CALL]: ({ sessionId }) => service.get(sessionId),
      [IPC.RENAME_CALL]: ({ sessionId, title }) => pipeline.rename(sessionId, title).then(() => ({ ok: true })),
      [IPC.RETRY_CALL]: ({ sessionId }) => pipeline.retry(sessionId).then(() => ({ ok: true })),
      [IPC.DELETE_CALL]: ({ sessionId }) => this.confirmDelete(sessionId),
      [IPC.COPY_DIAGNOSTICS]: async ({ sessionId }) => {
        clipboard.writeText(await service.diagnostics(sessionId));
        return { ok: true };
      },
      [IPC.OPEN_SUMMARY]: async ({ sessionId }) => {
        this.openKernUrl((await service.summaryUrl(sessionId)).url);
        return { ok: true };
      },
      [IPC.SIGN_IN]: () => { this.signIn(); return { ok: true }; },
    };
  }

  // A saved microphone that can no longer be read falls back to the Windows default.
  microphone() {
    try { return this.microphones.get(); } catch { return { mode: 'default' }; }
  }

  // Consent is decided here, not by the renderer: the one-time notice must have been seen, and
  // whether this call is transcribed is fixed at the moment it starts.
  async start() {
    const { enabled, noticeAcknowledged } = this.settings.get();
    if (!noticeAcknowledged) throw new Error('Read the recording notice first.');
    return this.supervisor.start({ microphone: this.microphone(), context: { transcribe: enabled } });
  }

  async confirmDelete(sessionId) {
    const choice = await this.dialog.showMessageBox(this.parentForDialog(), {
      type: 'warning', buttons: ['Cancel', 'Delete call'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'Delete call', message: 'Delete this call?',
      detail: 'Any audio on this PC is deleted, and the call is removed from Kern. This cannot be undone.',
    });
    if (choice.response !== 1) return { deleted: false };
    await this.pipeline.remove(sessionId);
    return { deleted: true };
  }

  parentForDialog() {
    return this.window && !this.window.isDestroyed() ? this.window : this.getParentWindow();
  }

  send(channel, payload) {
    this.ipc.send(channel, payload);
  }

  show() {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return this.window;
    }
    this.window = createRecorderWindow({ BrowserWindow: this.BrowserWindow, appRoot: this.appRoot, parent: this.getParentWindow() });
    this.window.on('closed', () => { this.window = null; });
    this.window.webContents.once('did-finish-load', () => {
      if (this.pendingOpen) this.send(IPC.OPEN_CALL, { sessionId: this.pendingOpen });
      this.pendingOpen = null;
    });
    return this.window;
  }

  // Brings the recorder forward on one call.
  openCall(sessionId) {
    const loading = !this.window || this.window.isDestroyed() || this.window.webContents.isLoading();
    if (loading) this.pendingOpen = sessionId;
    this.show();
    if (!loading) this.send(IPC.OPEN_CALL, { sessionId });
  }

  destroy() {
    this.ipc.dispose();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { RecorderController };
