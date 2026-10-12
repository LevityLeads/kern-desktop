// ------------------------------------------------------------------
// Browser discovery and launching, plus validation for the renderer
// facing "open this URL in browser X" request.
//
// Deliberately free of any `electron` import so it can be unit tested
// with plain node (see test/browsers.test.js).
//
// Nothing here ever goes through a shell: every launch is a spawn with
// an args array.
// ------------------------------------------------------------------
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BROWSER_NAMES = ['chrome', 'edge'];

const BROWSERS = {
  chrome: {
    win32: [
      { env: 'ProgramFiles', fallback: 'C:\\Program Files', rel: ['Google', 'Chrome', 'Application', 'chrome.exe'] },
      { env: 'ProgramFiles(x86)', fallback: 'C:\\Program Files (x86)', rel: ['Google', 'Chrome', 'Application', 'chrome.exe'] },
      { env: 'LOCALAPPDATA', fallback: '', rel: ['Google', 'Chrome', 'Application', 'chrome.exe'] },
    ],
    darwinApp: 'Google Chrome',
    linuxCommands: ['google-chrome', 'google-chrome-stable'],
  },
  edge: {
    win32: [
      { env: 'ProgramFiles(x86)', fallback: 'C:\\Program Files (x86)', rel: ['Microsoft', 'Edge', 'Application', 'msedge.exe'] },
      { env: 'ProgramFiles', fallback: 'C:\\Program Files', rel: ['Microsoft', 'Edge', 'Application', 'msedge.exe'] },
    ],
    darwinApp: 'Microsoft Edge',
    linuxCommands: ['microsoft-edge', 'microsoft-edge-stable'],
  },
};

function isFile(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** First executable named `command` on PATH, or null. */
function findOnPath(command) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve how to launch a browser on this machine.
 * Returns `{ cmd, argsFor(url) }` or null when it is not installed
 * (or `name` is not a known browser).
 */
function findBrowser(name) {
  if (!BROWSER_NAMES.includes(name)) return null;
  const def = BROWSERS[name];

  if (process.platform === 'win32') {
    for (const c of def.win32) {
      const base = process.env[c.env] || c.fallback;
      if (!base) continue;
      const exe = path.join(base, ...c.rel);
      if (isFile(exe)) return { cmd: exe, argsFor: (url) => [url] };
    }
    return null;
  }

  if (process.platform === 'darwin') {
    const bundle = `${def.darwinApp}.app`;
    const dirs = ['/Applications', path.join(process.env.HOME || '', 'Applications')];
    if (!dirs.some((d) => isDir(path.join(d, bundle)))) return null;
    return { cmd: 'open', argsFor: (url) => ['-a', def.darwinApp, url] };
  }

  for (const command of def.linuxCommands) {
    const found = findOnPath(command);
    if (found) return { cmd: found, argsFor: (url) => [url] };
  }
  return null;
}

/** Which of the known browsers are installed here, in a stable order. */
function availableBrowsers() {
  return BROWSER_NAMES.filter((name) => findBrowser(name) !== null);
}

/**
 * Launch `url` in the named browser, detached. Returns true if the
 * process was spawned, false if the browser is missing or spawn threw.
 * `onError` fires if the process fails to start asynchronously, which
 * lets the caller fall back to the OS default browser.
 */
function launchBrowser(name, url, onError) {
  const found = findBrowser(name);
  if (!found) return false;

  try {
    const child = spawn(found.cmd, found.argsFor(url), { detached: true, stdio: 'ignore' });
    child.once('error', () => {
      if (onError) onError();
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// Validation for the renderer -> main "open in browser" request.
// ------------------------------------------------------------------

/**
 * Validate an untrusted (name, url) pair. Returns `{ browser, href }`
 * with a normalised href, or null for anything that is not exactly
 * "chrome" / "edge" plus an http(s) URL.
 */
function parseOpenRequest(url, browser) {
  if (browser !== 'chrome' && browser !== 'edge') return null;
  if (typeof url !== 'string' || !url) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  return { browser, href: parsed.href };
}

/** True when `frameUrl` has exactly the origin of `expectedOrigin`. */
function isTrustedOrigin(frameUrl, expectedOrigin) {
  if (typeof frameUrl !== 'string' || typeof expectedOrigin !== 'string') return false;
  try {
    const origin = new URL(frameUrl).origin;
    // "null" is the origin of file:, data: and sandboxed frames.
    return origin !== 'null' && origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}

module.exports = {
  BROWSER_NAMES,
  findBrowser,
  availableBrowsers,
  launchBrowser,
  parseOpenRequest,
  isTrustedOrigin,
};
