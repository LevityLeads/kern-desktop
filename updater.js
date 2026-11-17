// ------------------------------------------------------------------
// Auto-update policy.
//
// Closing the window only hides Kern to the tray, and relaunching it
// re-shows the same process (single-instance lock). The app can run
// for weeks without restarting, so a single check at startup almost
// never fires. This module checks on a timer and on wake from sleep,
// then installs as soon as that will not interrupt anyone:
//
//   - window hidden (in the tray): install silently and relaunch
//   - window visible: show one notification, and install the next
//     time the window is hidden, the notification is clicked, or the
//     app quits
//
// Nothing downloads-and-installs while a capture is active (isBusy):
// downloads wait, the install waits, and the app never installs on
// quit mid-recording. The caller calls busyChanged() when the
// recorder state changes and the deferred work resumes at idle.
//
// The channel is pinned to stable. electron-updater defaults
// allowPrerelease to true for a prerelease current version (a
// 1.1.0-capture.N spike), which then only accepts tags in the
// "capture" channel and never sees a plain release.
//
// Electron objects are injected so the policy is testable with plain
// node (see test/updater.test.js).
// ------------------------------------------------------------------

const { UpdateGuard } = require('./recorder/update-guard');

const STARTUP_DELAY_MS = 10 * 1000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * @param {object} deps
 * @param {object} deps.autoUpdater   electron-updater's autoUpdater
 * @param {object} deps.app           electron app
 * @param {object} deps.powerMonitor  electron powerMonitor
 * @param {Function} deps.Notification electron Notification class
 * @param {Function} deps.getWindow   returns the main BrowserWindow or null
 * @param {Function} [deps.isBusy]    true while a capture is active; defers download and install
 * @param {object} [deps.timers]      { setTimeout, setInterval } for tests
 * @param {object} [deps.log]         console-like logger
 */
function setupAutoUpdater(deps) {
  const {
    autoUpdater,
    app,
    powerMonitor,
    Notification,
    getWindow,
    isBusy = () => false,
    timers = { setTimeout, setInterval },
    log = console,
  } = deps;

  autoUpdater.allowPrerelease = false;
  // The guard owns download and install-on-quit while a capture is active.
  const guard = new UpdateGuard(autoUpdater, isBusy);
  guard.configure();
  autoUpdater.autoInstallOnAppQuit = !isBusy();

  let readyVersion = null;
  let installing = false;
  let wantInstall = false;
  let notified = false;

  function check() {
    // Once an update is downloaded there is nothing left to look for.
    if (readyVersion || installing) return;
    Promise.resolve()
      .then(() => autoUpdater.checkForUpdates())
      .catch((err) => log.error('Update check failed:', err));
  }

  function install() {
    if (installing) return;
    if (isBusy()) {
      wantInstall = true;
      return;
    }
    installing = true;
    wantInstall = false;
    app.isQuitting = true;
    try {
      // isSilent: no NSIS wizard. isForceRunAfter: reopen Kern afterwards.
      autoUpdater.quitAndInstall(true, true);
    } catch (err) {
      installing = false;
      app.isQuitting = false;
      log.error('Update install failed:', err);
    }
  }

  function isWindowVisible() {
    const win = getWindow();
    return !!win && !win.isDestroyed() && win.isVisible();
  }

  function onReady(version) {
    readyVersion = version;

    if (!isWindowVisible()) {
      install();
      return;
    }

    const win = getWindow();
    win.once('hide', install);

    if (!notified && Notification && Notification.isSupported && Notification.isSupported()) {
      notified = true;
      const note = new Notification({
        title: 'Kern update ready',
        body: `Version ${version} installs next time Kern is in the tray. Click to restart now.`,
      });
      note.on('click', install);
      note.show();
    }
  }

  function busyChanged() {
    guard.captureStateChanged();
    if (isBusy() || !readyVersion || installing) return;
    if (wantInstall || !isWindowVisible()) install();
  }

  autoUpdater.on('update-available', (info) => log.log('Update available:', info && info.version));
  autoUpdater.on('update-downloaded', (info) => onReady(info && info.version));
  autoUpdater.on('error', (err) => log.error('Auto-updater error:', err));

  timers.setTimeout(check, STARTUP_DELAY_MS);
  timers.setInterval(check, CHECK_INTERVAL_MS);
  if (powerMonitor) powerMonitor.on('resume', check);

  return { check, install, busyChanged, get readyVersion() { return readyVersion; } };
}

module.exports = { setupAutoUpdater, STARTUP_DELAY_MS, CHECK_INTERVAL_MS };
