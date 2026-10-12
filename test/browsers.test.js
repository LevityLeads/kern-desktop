const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseOpenRequest, isTrustedOrigin, findBrowser, availableBrowsers, launchBrowser } = require('../browsers');

test('parseOpenRequest accepts http(s) with chrome or edge', () => {
  assert.deepEqual(parseOpenRequest('https://example.com/a?b=1', 'chrome'), { browser: 'chrome', href: 'https://example.com/a?b=1' });
  assert.deepEqual(parseOpenRequest('http://example.com', 'edge'), { browser: 'edge', href: 'http://example.com/' });
});

test('parseOpenRequest rejects bad browser names', () => {
  for (const b of ['Chrome', 'firefox', '', 'chrome ', undefined, null, 1, {}, ['chrome'], '--flag']) {
    assert.equal(parseOpenRequest('https://example.com', b), null, String(b));
  }
});

test('parseOpenRequest rejects non-http(s) and unparseable urls', () => {
  const bad = [
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://example.com',
    'chrome://settings',
    'ms-msdt:/id',
    '--user-data-dir=x',
    '-flag https://example.com',
    'example.com',
    '',
    undefined,
    null,
    42,
    {},
    ['https://example.com'],
  ];
  for (const u of bad) assert.equal(parseOpenRequest(u, 'chrome'), null, String(u));
});

test('isTrustedOrigin matches origin exactly', () => {
  const kern = 'https://kern.example.com';
  assert.equal(isTrustedOrigin('https://kern.example.com/thread/1?x=2', kern), true);
  assert.equal(isTrustedOrigin('https://kern.example.com:443/', kern), true);
  assert.equal(isTrustedOrigin('https://evil.com/', kern), false);
  assert.equal(isTrustedOrigin('https://kern.example.com.evil.com/', kern), false);
  assert.equal(isTrustedOrigin('https://evil.com/https://kern.example.com', kern), false);
  assert.equal(isTrustedOrigin('http://kern.example.com/', kern), false);
  assert.equal(isTrustedOrigin('https://kern.example.com:8443/', kern), false);
  assert.equal(isTrustedOrigin('file:///x', kern), false);
  assert.equal(isTrustedOrigin('data:text/html,hi', kern), false);
  assert.equal(isTrustedOrigin('about:blank', kern), false);
  assert.equal(isTrustedOrigin('', kern), false);
  assert.equal(isTrustedOrigin(undefined, kern), false);
  assert.equal(isTrustedOrigin('https://kern.example.com/', null), false);
  assert.equal(isTrustedOrigin('https://kern.example.com/', 'not a url'), false);
});

test('findBrowser rejects unknown names', () => {
  assert.equal(findBrowser('firefox'), null);
  assert.equal(findBrowser(undefined), null);
  assert.equal(findBrowser('__proto__'), null);
});

test('linux: finds a browser on PATH and spawns it with an args array', { skip: process.platform !== 'linux' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-browsers-'));
  const marker = path.join(dir, 'argv.txt');
  const fake = path.join(dir, 'microsoft-edge');
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${marker}"\n`, { mode: 0o755 });

  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    assert.deepEqual(availableBrowsers(), ['edge']);
    assert.equal(findBrowser('chrome'), null);
    assert.equal(launchBrowser('chrome', 'https://example.com'), false);

    // A hostile-looking but valid URL must arrive as ONE argv element.
    const url = 'https://example.com/?a=1&b=$(touch%20pwned);rm';
    assert.equal(launchBrowser('edge', url), true);
    for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(fs.readFileSync(marker, 'utf8'), url + '\n');
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
