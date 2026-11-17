'use strict';

class UpdateGuard {
  constructor(autoUpdater, isCaptureActive) {
    this.autoUpdater = autoUpdater;
    this.isCaptureActive = isCaptureActive;
    this.downloaded = false;
    this.deferred = false;
  }

  configure() {
    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = false;

    this.autoUpdater.on('update-available', () => {
      if (this.isCaptureActive()) {
        this.deferred = true;
        return;
      }
      this.autoUpdater.downloadUpdate().catch((error) => this.autoUpdater.emit('error', error));
    });

    this.autoUpdater.on('update-downloaded', () => {
      this.downloaded = true;
      this.autoUpdater.autoInstallOnAppQuit = !this.isCaptureActive();
    });
  }

  captureStateChanged() {
    if (this.isCaptureActive()) {
      this.autoUpdater.autoInstallOnAppQuit = false;
      return;
    }
    if (this.downloaded) this.autoUpdater.autoInstallOnAppQuit = true;
    if (this.deferred) {
      this.deferred = false;
      this.autoUpdater.downloadUpdate().catch((error) => this.autoUpdater.emit('error', error));
    }
  }
}

module.exports = { UpdateGuard };
