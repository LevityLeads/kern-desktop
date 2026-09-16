'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { renderCall } = require('../recorder/call-render');

function child() {
  const process = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = () => { process.emit('close', null); return true; };
  return process;
}
test('render runs separately without shell, drains stderr and awaits close', async () => {
  const process = child(); let settled = false;
  const work = renderCall('/helper', '/session', { spawnProcess: (file, args, options) => {
    assert.equal(file, '/helper'); assert.deepEqual(args.slice(0, 2), ['--render', '/session']);
    assert.equal(options.shell, false); assert.deepEqual(options.stdio, ['ignore', 'ignore', 'pipe']);
    return process;
  } }).then(() => { settled = true; });
  process.emit('exit', 0);
  await Promise.resolve();
  assert.equal(settled, false);
  process.stderr.emit('data', Buffer.alloc(100000));
  process.emit('close', 0);
  await work;
});
test('render errors never expose native output or private paths', async () => {
  const process = child();
  const work = renderCall('/private/helper', '/private/session', { spawnProcess: () => process });
  process.stderr.emit('data', Buffer.from('secret provider key/path'));
  process.emit('error', new Error('secret private path'));
  await assert.rejects(work, error => error.code === 'render-start' && !error.message.includes('secret'));
});
test('abort kills only processing child and waits for close', async () => {
  const process = child(), controller = new AbortController();
  let killed = false;
  process.kill = () => { killed = true; process.emit('close', null); return true; };
  const work = renderCall('/helper', '/session', { spawnProcess: () => process, signal: controller.signal });
  controller.abort();
  await assert.rejects(work, { code: 'cancelled' });
  assert.equal(killed, true);
});
