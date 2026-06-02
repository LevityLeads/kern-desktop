const { app, BrowserWindow, Tray, Menu, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const KERN_URL = 'https://kern-interface.vercel.app';

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
});

let mainWindow = null;
let tray = null;

// ------------------------------------------------------------------
// Single instance lock
// ------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
    setupAutoUpdater();
  });
}

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

    // Transparency & material
    transparent: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',     // Windows 11 Mica/Acrylic
    vibrancy: 'under-window',          // macOS

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

  mainWindow.loadURL(KERN_URL);

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
    if (url.startsWith(KERN_URL)) {
      return { action: 'allow' };
    }
    openExternalUrl(url);
    return { action: 'deny' };
  });

  // Catch in-page navigations to external domains
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(KERN_URL)) {
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
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
