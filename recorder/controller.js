'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { dialog, shell, clipboard } = require('electron');
const { registerRecorderIpc } = require('./ipc');
const catalog = require('./session-catalog');
const { createRecorderWindow } = require('./window');

class RecorderController {
  constructor({ BrowserWindow, ipcMain, supervisor, appRoot, recordingsRoot, getParentWindow,
    callProcessing, focusMain, microphonePreference }) {
    this.BrowserWindow = BrowserWindow;
    this.supervisor = supervisor;
    this.appRoot = appRoot;
    this.recordingsRoot = recordingsRoot;
    this.getParentWindow = getParentWindow;
    this.callProcessing = callProcessing;
    this.focusMain = focusMain;
    this.window = null;
    this.disposeIpc = registerRecorderIpc({
      ipcMain, getRecorderWindow: () => this.window, supervisor,
      trustedRecorderUrl: pathToFileURL(path.join(appRoot, 'recorder-ui', 'index.html')).href,
      handlers: {
        getMicrophone: () => microphonePreference.get(),
        setMicrophone: selection => microphonePreference.set(selection),
        listSessions: () => catalog.listSessions(recordingsRoot),
        getSession: (id) => catalog.readManifest(recordingsRoot, id),
        getPlaybackUrl: (payload) => catalog.buildPlaybackUrl(recordingsRoot, payload),
        exportSession: (id) => this.exportAudio(id),
        showInFolder: (id) => this.showInFolder(id),
        getCall: (id) => this.processing().getCall(id),
        prepareCall: (id) => this.processing().prepare(id),
        transcribe: (id) => this.confirmAndTranscribe(id),
        exportTranscript: (id) => this.exportTranscript(id),
        copyTranscript: (id) => this.copyTranscript(id),
        getTranscriptionEnabled: () => this.processing().getTranscriptionEnabled(),
        setTranscriptionEnabled: (enabled) => this.processing().setTranscriptionEnabled(enabled),
        signIn: () => this.signIn(),
      },
    });
  }

  processing() {
    if (!this.callProcessing) throw new Error('Call processing is unavailable');
    return this.callProcessing;
  }

  show() {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return this.window;
    }
    this.window = createRecorderWindow({
      BrowserWindow: this.BrowserWindow, appRoot: this.appRoot, parent: this.getParentWindow(),
    });
    this.window.on('closed', () => { this.window = null; });
    return this.window;
  }

  parentForDialog() { return this.window && !this.window.isDestroyed() ? this.window : this.getParentWindow(); }

  async validateExportDestination(filePath) {
    const [root, parent] = await Promise.all([
      fs.promises.realpath(this.recordingsRoot), fs.promises.realpath(path.dirname(filePath)),
    ]);
    const target = path.join(parent, path.basename(filePath));
    const relative = path.relative(root, target);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Choose an export destination outside Kern Recordings to preserve the originals.');
    }
    try {
      const stat = await fs.promises.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Export destination must be a regular file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return target;
  }

  // Same-directory temp then atomic rename so a failed export never truncates an existing file.
  async atomicWrite(destination, write) {
    const temporary = path.join(path.dirname(destination), `.kern-export-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      await write(handle);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(temporary, destination);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async exportAudio(sessionId) {
    // Service owns artifact identity, checksums and symlink/reparse containment.
    const source = await this.processing().getPlaybackFile(sessionId);
    const result = await dialog.showSaveDialog(this.parentForDialog(), {
      title: 'Export call audio', buttonLabel: 'Export audio',
      defaultPath: `Kern call ${sessionId}.wav`,
      filters: [{ name: 'WAV audio', extensions: ['wav'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    // Revalidate after a potentially long user dialog before reading any bytes.
    const validatedSource = await this.processing().getPlaybackFile(sessionId);
    if (source !== validatedSource) throw new Error('Call audio changed during export. Please retry.');
    const destination = await this.validateExportDestination(result.filePath);
    if (path.resolve(validatedSource) === path.resolve(destination)) throw new Error('Choose a destination outside the original call audio.');
    const bytes = await fs.promises.readFile(validatedSource);
    await this.atomicWrite(destination, (handle) => handle.writeFile(bytes));
    shell.showItemInFolder(destination);
    return { canceled: false };
  }

  async confirmAndTranscribe(sessionId) {
    const choice = await dialog.showMessageBox(this.parentForDialog(), {
      type: 'question', buttons: ['Cancel', 'Transcribe'], defaultId: 0, cancelId: 0,
      title: 'Transcribe this call',
      message: 'Send this recording to Kern to transcribe it?',
      detail: 'The audio is uploaded to your private Kern storage and transcribed with Groq. The original recording stays on this PC.',
    });
    if (choice.response !== 1) return { canceled: true };
    return this.processing().transcribe(sessionId);
  }

  async transcriptText(sessionId) {
    const call = await this.processing().getCall(sessionId);
    if (typeof call.transcript?.text !== 'string') throw new Error('Transcript is not ready');
    return call.transcript.text;
  }

  async copyTranscript(sessionId) {
    const text = await this.transcriptText(sessionId);
    clipboard.writeText(text);
    return { ok: true };
  }

  async exportTranscript(sessionId) {
    const text = await this.transcriptText(sessionId);
    const result = await dialog.showSaveDialog(this.parentForDialog(), {
      title: 'Export transcript', buttonLabel: 'Export text',
      defaultPath: `Kern call ${sessionId}.txt`,
      filters: [{ name: 'Plain text', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const destination = await this.validateExportDestination(result.filePath);
    await this.atomicWrite(destination, (handle) => handle.writeFile(text, 'utf8'));
    shell.showItemInFolder(destination);
    return { canceled: false };
  }

  signIn() {
    if (this.focusMain) { this.focusMain(); return { ok: true }; }
    const parent = this.getParentWindow();
    if (!parent || parent.isDestroyed()) throw new Error('Open Kern to sign in');
    if (parent.isMinimized()) parent.restore();
    parent.show();
    parent.focus();
    return { ok: true };
  }

  showInFolder(sessionId) {
    const manifest = catalog.readManifest(this.recordingsRoot, sessionId);
    const manifestFile = catalog.manifestPath(this.recordingsRoot, sessionId);
    if (!fs.existsSync(manifestFile) || manifest.sessionId !== sessionId) throw new Error('Recording manifest was not found');
    shell.showItemInFolder(manifestFile);
    return { ok: true };
  }

  destroy() {
    this.disposeIpc?.();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { RecorderController };
