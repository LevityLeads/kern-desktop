'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateGuard } = require('../recorder/update-guard');

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.downloads = 0;
  }
  async downloadUpdate() { this.downloads += 1; }
}

test('update download and install are deferred during capture', async () => {
  const updater = new FakeUpdater();
  let active = true;
  const guard = new UpdateGuard(updater, () => active);
  guard.configure();

  updater.emit('update-available');
  await Promise.resolve();
  assert.equal(updater.downloads, 0);
  assert.equal(updater.autoInstallOnAppQuit, false);

  active = false;
  guard.captureStateChanged();
  await Promise.resolve();
  assert.equal(updater.downloads, 1);
  updater.emit('update-downloaded');
  assert.equal(updater.autoInstallOnAppQuit, true);
});
