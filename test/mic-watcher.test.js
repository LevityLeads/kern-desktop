'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BACKOFF_MAX_MS, BACKOFF_START_MS, MicWatcher, parseMicLine } = require('../recorder/mic-watcher');

class FakeChild extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.killed = false; }
  kill() { this.killed = true; }
}

function rig() {
  const spawns = [];
  const timers = [];
  const quiet = { error() {} };
  const watcher = new MicWatcher({
    helperPath: 'C:\\app\\Kern.Recorder.Helper.exe', platform: 'win32', parentPid: 4242, log: quiet,
    spawnProcess: (file, args, options) => { const child = new FakeChild(); spawns.push({ file, args, options, child }); return child; },
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
  });
  const snapshots = [];
  watcher.on('apps', (apps) => snapshots.push(apps));
  return { watcher, spawns, timers, snapshots };
}

test('spawns the helper in --mic-watch mode with the parent pid', () => {
  const { watcher, spawns } = rig();
  watcher.start();
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['--mic-watch', '--parent-pid', '4242']);
  assert.equal(spawns[0].options.shell, false);
});

test('does nothing off Windows', () => {
  const spawns = [];
  const watcher = new MicWatcher({ helperPath: 'x', platform: 'linux', spawnProcess: () => spawns.push(1) });
  watcher.start();
  assert.equal(spawns.length, 0);
});

test('parses mic lines, ignores malformed ones and handles lines split across chunks', () => {
  const { watcher, spawns, snapshots } = rig();
  watcher.start();
  const { stdout } = spawns[0].child;
  stdout.emit('data', 'not json\n{"type":"mic","apps":[{"pid":1,"name":"Zoom"}]}\n{"type":"mic"');
  stdout.emit('data', ',"apps":[]}\n{"type":"error","code":"enumerate-failed"}\n{"type":"mic","apps":"x"}\n');
  assert.deepEqual(snapshots, [[{ pid: 1, name: 'zoom' }], []]);
});

test('parseMicLine drops entries with a bad pid or name', () => {
  assert.deepEqual(parseMicLine('{"type":"mic","apps":[{"pid":0,"name":"a"},{"pid":2,"name":""},{"pid":3,"name":5},{"pid":4,"name":"ok"}]}'), [{ pid: 4, name: 'ok' }]);
  assert.equal(parseMicLine('[]'), null);
  assert.equal(parseMicLine('null'), null);
});

test('an exit clears the snapshot and restarts with doubling backoff up to 5 minutes', () => {
  const { watcher, spawns, timers, snapshots } = rig();
  watcher.start();
  const delays = [];
  for (let i = 0; i < 10; i += 1) {
    spawns.at(-1).child.emit('exit', 1, null);
    delays.push(timers.at(-1).ms);
    timers.at(-1).fn();
  }
  assert.equal(delays[0], BACKOFF_START_MS);
  assert.equal(delays[1], BACKOFF_START_MS * 2);
  assert.equal(delays[2], BACKOFF_START_MS * 4);
  assert.equal(Math.max(...delays), BACKOFF_MAX_MS);
  assert.equal(delays.at(-1), BACKOFF_MAX_MS);
  assert.equal(spawns.length, 11);
  assert.deepEqual(snapshots[0], []);
});

test('a healthy line resets the backoff', () => {
  const { watcher, spawns, timers } = rig();
  watcher.start();
  spawns[0].child.emit('exit', 1, null);
  timers.at(-1).fn();
  spawns[1].child.emit('exit', 1, null);
  assert.equal(timers.at(-1).ms, BACKOFF_START_MS * 2);
  timers.at(-1).fn();
  spawns[2].child.stdout.emit('data', '{"type":"mic","apps":[]}\n');
  spawns[2].child.emit('exit', 1, null);
  assert.equal(timers.at(-1).ms, BACKOFF_START_MS);
});

test('error followed by exit schedules one restart, not two', () => {
  const { watcher, spawns, timers } = rig();
  watcher.start();
  spawns[0].child.emit('error', new Error('ENOENT'));
  spawns[0].child.emit('exit', null, null);
  assert.equal(timers.length, 1);
});

test('stop() kills the child, cancels a pending restart and prevents any further one', () => {
  const { watcher, spawns, timers } = rig();
  watcher.start();
  spawns[0].child.emit('exit', 1, null);
  watcher.stop();
  assert.equal(timers.at(-1).cleared, true);
  watcher.start();
  const second = spawns.length;
  watcher.stop();
  assert.equal(spawns.at(-1).child.killed, true);
  spawns.at(-1).child.emit('exit', 0, null);
  assert.equal(timers.filter((t) => !t.cleared).length, 0);
  assert.equal(spawns.length, second);
});
