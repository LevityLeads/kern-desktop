const { app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ------------------------------------------------------------------
// Kern host resolution.
//
// The host is DELIBERATELY not hardcoded. This repo is public so that
// electron-updater can read releases anonymously, and the Kern server
// returns a flat 404 to any request arriving on a non-canonical
// hostname specifically so that hostname is not discoverable. Baking
// it into source here would hand back exactly what that protects.
//
// Resolution order:
//   1. KERN_URL environment variable (dev / power use)
//   2. `kernUrl` persisted in settings.json under userData
//   3. nothing, in which case the first-run setup window asks for it
//
// v1.0.2 and earlier hardcoded https://kern-interface.vercel.app,
// which now 404s. Any such value found in settings is discarded.
// ------------------------------------------------------------------
const DEAD_HOSTS = new Set(['kern-interface.vercel.app']);

/**
 * Coerce user input into a bare origin (scheme + host + optional port).
 * Accepts "example.com", "example.com/", "https://example.com/foo".
 * Returns null if it cannot be made into a sane https origin.
 */
function normaliseKernUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || !host.includes('.')) {
    // Allow bare loopback for local development, reject everything else.
    const isLoopback = host === 'localhost' || host === '127.0.0.1';
    if (!isLoopback) return null;
  }
  if (DEAD_HOSTS.has(host)) return null;

  const isLoopback = host === 'localhost' || host === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLoopback) return null;

  return parsed.port ? `${parsed.protocol}//${host}:${parsed.port}` : `${parsed.protocol}//${host}`;
}

/** Current Kern origin, or null when the app is not configured yet. */
let kernUrl = null;

// ------------------------------------------------------------------
// Open external links in Google Chrome, not the OS default browser.
// Falls back to the OS default (shell.openExternal) if Chrome isn't
// found or fails to launch.
// ------------------------------------------------------------------
function launchChrome(url) {
  const platform = process.platform;
  let cmd;
  let args;

  if (platform === 'win32') {
    const candidates = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    cmd = candidates.find((c) => {
      try {
        return c && fs.existsSync(c);
      } catch {
        return false;
      }
    });
    if (!cmd) return false; // Chrome not installed, let caller fall back
    args = [url];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = ['-a', 'Google Chrome', url];
  } else {
    cmd = 'google-chrome';
    args = [url];
  }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    // If the launch fails asynchronously (e.g. Chrome missing on
    // mac/linux), fall back to the OS default browser.
    child.once('error', () => shell.openExternal(url));
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function openExternalUrl(url) {
  if (!launchChrome(url)) shell.openExternal(url);
}

// ------------------------------------------------------------------
// Simple JSON store (avoids ESM issues with electron-store v8+)
// ------------------------------------------------------------------
class JsonStore {
  constructor(defaults = {}) {
    this._path = path.join(app.getPath('userData'), 'settings.json');
    this._defaults = defaults;
    this._data = { ...defaults };
    try {
      const raw = fs.readFileSync(this._path, 'utf8');
      this._data = { ...defaults, ...JSON.parse(raw) };
    } catch {
      // File doesn't exist yet, use defaults
    }
  }

  get(key) {
    return key ? this._data[key] : this._data;
  }

  set(key, value) {
    this._data[key] = value;
    try {
      fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2));
    } catch (err) {
      console.error('Failed to persist settings:', err);
    }
  }
}

const store = new JsonStore({
  windowBounds: { x: undefined, y: undefined, width: 1200, height: 800 },
  windowMaximized: false,
  kernUrl: null,
});

let mainWindow = null;
let setupWindow = null;
let tray = null;

/**
 * Resolve the Kern origin from env, then persisted settings.
 * Silently drops a persisted value that is no longer usable (e.g. the
 * old hardcoded vercel.app host carried over from v1.0.2).
 */
function resolveKernUrl() {
  const fromEnv = normaliseKernUrl(process.env.KERN_URL);
  if (fromEnv) return fromEnv;

  const stored = store.get('kernUrl');
  const fromStore = normaliseKernUrl(stored);
  if (stored && !fromStore) store.set('kernUrl', null);
  return fromStore;
}

// ------------------------------------------------------------------
// Platform-specific window material config.
//
// Windows: DO NOT use `transparent: true`. It silently breaks
// `-webkit-app-region: drag` (Electron #32502, closed wontfix) and
// fights `backgroundMaterial` acrylic (#39959). You get a window you
// can resize but not drag. The correct way to get Win11 acrylic is
// `transparent: false` + `backgroundColor: '#00000000'` +
// `backgroundMaterial: 'acrylic'`, which keeps drag regions working.
// Acrylic is only safe on Windows 11 (build >= 22000); on Win10 it
// artifacts (white->black), so fall back to a solid background there.
//
// macOS: vibrancy DOES need `transparent: true`, so keep it there.
// ------------------------------------------------------------------
function getMaterialOptions() {
  if (process.platform === 'darwin') {
    return {
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'under-window',
    };
  }

  if (process.platform === 'win32') {
    const build = parseInt((os.release() || '').split('.')[2], 10) || 0;
    const isWin11 = build >= 22000;
    return isWin11
      ? {
          transparent: false,
          backgroundColor: '#00000000',
          backgroundMaterial: 'acrylic',
        }
      : {
          // Win10: acrylic is broken, use an opaque dark background.
          transparent: false,
          backgroundColor: '#0a0614',
        };
  }

  // Linux / other
  return {
    transparent: false,
    backgroundColor: '#0a0614',
  };
}

// ------------------------------------------------------------------
// Single instance lock
// ------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const target = mainWindow || setupWindow;
    if (target) {
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
    }
  });

  app.whenReady().then(() => {
    kernUrl = resolveKernUrl();
    if (kernUrl) {
      createWindow();
    } else {
      createSetupWindow();
    }
    createTray();
    setupAutoUpdater();
  });
}

// ------------------------------------------------------------------
// First-run / reconfiguration setup window.
//
// Asks for the Kern host, validates it, persists it to settings.json,
// then swaps to the real app window. Also used to recover when the
// configured host stops answering.
// ------------------------------------------------------------------
function createSetupWindow(errorMessage) {
  if (setupWindow) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 560,
    height: 420,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0a0614',
    title: 'Kern setup',
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'setup-preload.js'),
    },
  });

  setupWindow.setMenuBarVisibility(false);

  const query = {};
  const existing = store.get('kernUrl');
  if (existing) query.current = existing;
  if (errorMessage) query.error = errorMessage;

  setupWindow.loadFile(path.join(__dirname, 'setup.html'), { query });

  setupWindow.once('ready-to-show', () => setupWindow.show());

  setupWindow.on('closed', () => {
    setupWindow = null;
    // Closing setup without ever configuring anything leaves nothing to
    // show, so quit rather than sit invisibly in the tray.
    if (!kernUrl && !mainWindow) {
      app.isQuitting = true;
      app.quit();
    }
  });
}

ipcMain.handle('kern-setup:save', (_event, rawValue) => {
  const normalised = normaliseKernUrl(rawValue);

  if (!normalised) {
    return { ok: false, error: 'That does not look like a valid https address.' };
  }

  store.set('kernUrl', normalised);
  kernUrl = normalised;

  if (setupWindow) {
    const win = setupWindow;
    setupWindow = null;
    win.close();
  }

  if (mainWindow) {
    mainWindow.loadURL(kernUrl);
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }

  return { ok: true, url: normalised };
});

ipcMain.handle('kern-setup:cancel', () => {
  if (setupWindow) setupWindow.close();
  return { ok: true };
});

// ------------------------------------------------------------------
// Window creation
// ------------------------------------------------------------------
function createWindow() {
  const { x, y, width, height } = store.get('windowBounds');
  const wasMaximized = store.get('windowMaximized');

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 800,
    minHeight: 600,

    // Transparency & material (platform-split, see getMaterialOptions).
    // On Windows this deliberately avoids `transparent: true` so window
    // dragging via -webkit-app-region works.
    ...getMaterialOptions(),

    // Frameless with native window controls overlay
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#ffffff',
      height: 36,
    },

    // Security
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },

    // Appearance
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  if (wasMaximized) {
    mainWindow.maximize();
  }

  // Show once ready to avoid a white flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadURL(kernUrl);

  // ------------------------------------
  // Dead-host recovery.
  //
  // A wrong or stale host does not fail to load, it loads a 404 page,
  // which is how v1.0.2 silently became a window saying "Not Found".
  // Treat a 4xx/5xx on the top-level frame as a configuration problem
  // and reopen setup instead of leaving a dead window on screen.
  // ------------------------------------
  mainWindow.webContents.on('did-navigate', (_event, url, httpResponseCode) => {
    if (!kernUrl || !url.startsWith(kernUrl)) return;
    if (httpResponseCode && httpResponseCode >= 400) {
      createSetupWindow(
        `${kernUrl} answered ${httpResponseCode}. Check the address, or update it if the host has moved.`
      );
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which fires on ordinary redirects and cancels.
    if (!isMainFrame || errorCode === -3) return;
    createSetupWindow(`Could not reach ${kernUrl} (${errorDescription}).`);
  });

  // ------------------------------------
  // Inject CSS to make body translucent so Mica bleeds through
  // ------------------------------------
  mainWindow.webContents.on('did-finish-load', () => {
    // Inject transparency + drag region + titlebar inset variable.
    // Override the opaque dark theme backgrounds so the Windows 11
    // Acrylic material bleeds through. Each layer needs its own
    // alpha or the effect gets buried under opaque paint.
    mainWindow.webContents.insertCSS(`
      :root {
        --titlebar-inset-right: 140px;
      }

      /* Kill ALL opaque backgrounds. Layers stack multiplicatively,
         so even 0.5 + 0.5 = nearly opaque. Make everything very
         thin and let acrylic do the heavy lifting. */

      body {
        background-color: transparent !important;
      }

      /* The outermost grid container */
      .fixed.inset-0 {
        background-color: rgba(10, 6, 20, 0.45) !important;
      }

      /* Purple glow pseudo: tone way down */
      .bg-purple-glow::before {
        opacity: 0.3 !important;
      }

      /* Sidebar, headers, input bars */
      .glass-panel {
        background: rgba(15, 10, 28, 0.30) !important;
      }

      /* Thread content area */
      .glass-surface {
        background: rgba(10, 6, 22, 0.15) !important;
      }

      /* Message bubbles, cards */
      .bg-card,
      .bg-card\\/80,
      .bg-card\\/60,
      .bg-card\\/40,
      [class*="bg-card"] {
        background-color: rgba(18, 12, 32, 0.35) !important;
      }

      /* Secondary surfaces (hover states, badges) */
      .bg-secondary,
      .bg-secondary\\/40,
      .bg-secondary\\/30,
      [class*="bg-secondary"] {
        background-color: rgba(25, 18, 40, 0.30) !important;
      }

      /* Sessions panel */
      .border-l.border-border.glass-panel {
        background: rgba(12, 8, 24, 0.35) !important;
      }

      /* Borders: make them more subtle so they don't create hard lines */
      .border-border,
      .border-b,
      .border-l {
        border-color: rgba(255, 255, 255, 0.06) !important;
      }
    `);

    // Inject a fixed drag bar at the top of the page for window movement.
    // Sits behind the native titlebar overlay buttons (top-right).
    mainWindow.webContents.executeJavaScript(`
      if (!document.getElementById('kern-drag-bar')) {
        const bar = document.createElement('div');
        bar.id = 'kern-drag-bar';
        bar.style.cssText = [
          'position: fixed',
          'top: 0',
          'left: 0',
          'right: 0',
          'height: 36px',
          'z-index: 99999',
          '-webkit-app-region: drag',
          'pointer-events: auto',
        ].join(';');
        document.body.appendChild(bar);
      }
    `);
  });

  // ------------------------------------
  // Open external links in the default browser
  // ------------------------------------
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (kernUrl && url.startsWith(kernUrl)) {
      return { action: 'allow' };
    }
    openExternalUrl(url);
    return { action: 'deny' };
  });

  // Catch in-page navigations to external domains
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!kernUrl || !url.startsWith(kernUrl)) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });

  // ------------------------------------
  // Persist window bounds
  // ------------------------------------
  const saveBounds = () => {
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
    store.set('windowMaximized', mainWindow.isMaximized());
  };

  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Hide to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ------------------------------------------------------------------
// System tray
// ------------------------------------------------------------------
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: () => {
        if (mainWindow) {
          mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        }
      },
    },
    {
      label: 'Change Kern address...',
      click: () => createSetupWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Kern');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ------------------------------------------------------------------
// Auto-updater (wired up, configured via electron-builder publish)
// ------------------------------------------------------------------
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err);
  });

  // Check for updates after a short delay (don't block startup)
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('Update check failed:', err);
    });
  }, 5000);
}

// ------------------------------------------------------------------
// App lifecycle
// ------------------------------------------------------------------
app.on('window-all-closed', () => {
  // On macOS, apps typically stay in the dock
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // macOS dock click
  if (mainWindow === null) {
    if (kernUrl) {
      createWindow();
    } else {
      createSetupWindow();
    }
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
