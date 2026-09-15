'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { RecorderSupervisor } = require('../recorder/supervisor');

class FakeTransport extends EventEmitter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.closed = false;
  }
  async connect() {}
  request(command, payload) { return this.handler(command, payload); }
  close() { this.closed = true; }
}

function activeSupervisor(handler) {
  const transport = new FakeTransport(handler);
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 1; child.emit('exit', 1, null); };
  const supervisor = new RecorderSupervisor({
    recordingsRoot: '/tmp/recordings',
    helperPath: '/tmp/helper.exe',
    platform: 'win32',
    transportFactory: () => transport,
  });
  supervisor.transport = transport;
  supervisor.child = child;
  supervisor.status = {
    ...supervisor.status,
    state: 'recording',
    sessionId: '9b918241-3cb0-447c-8861-8f14358563e7',
  };
  return { supervisor, transport, child };
}

test('pause exposes pending state and sends request time until helper acknowledges cutoff', async () => {
  let resolveRequest;
  let requestPayload;
  const { supervisor } = activeSupervisor((_command, payload) => {
    requestPayload = payload;
    return new Promise((resolve) => { resolveRequest = resolve; });
  });
  const pending = supervisor.pause();

  assert.equal(supervisor.snapshot().state, 'pausing');
  assert.equal(supervisor.snapshot().pendingCommand, 'pause');
  assert.equal(Number.isInteger(requestPayload.requestedAtUnixMs), true);
  assert.equal(requestPayload.requestedAtMonotonicMs > 0, true);
  resolveRequest({ state: 'paused', effectiveCutoffTicks: 123 });
  const result = await pending;
  assert.equal(result.state, 'paused');
  assert.equal(result.effectiveCutoffTicks, 123);
  assert.equal(result.pendingCommand, null);
});

test('unacknowledged control interrupts and terminates helper', async () => {
  const error = Object.assign(new Error('too slow'), { code: 'helper-timeout' });
  const { supervisor, transport, child } = activeSupervisor(() => Promise.reject(error));

  await assert.rejects(supervisor.pause(), /too slow/);

  assert.equal(supervisor.snapshot().state, 'interrupted');
  assert.equal(supervisor.snapshot().failure.code, 'unacknowledged-command');
  assert.equal(transport.closed, true);
  assert.equal(child.exitCode, 1);
});

test('idle helper is killed if graceful shutdown does not exit', async () => {
  const { supervisor, transport, child } = activeSupervisor((command) => {
    assert.equal(command, 'shutdown');
    return Promise.resolve({});
  });
  supervisor.status.state = 'idle';

  await supervisor._shutdownIdleHelper();

  assert.equal(transport.closed, true);
  assert.equal(child.exitCode, 1);
  assert.equal(supervisor.transport, null);
  assert.equal(supervisor.child, null);
});

test('non-Windows capture fails explicitly', async () => {
  const supervisor = new RecorderSupervisor({
    recordingsRoot: '/tmp/recordings',
    helperPath: '/tmp/helper.exe',
    platform: 'linux',
  });
  await assert.rejects(supervisor.listDevices(), (error) => error.code === 'windows-only');
});
