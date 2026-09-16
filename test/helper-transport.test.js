'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  FrameDecoder,
  HelperTransport,
  MAX_MESSAGE_BYTES,
  encodeMessage,
} = require('../recorder/helper-transport');

function fakeSocket(result) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = () => true;
  setImmediate(() => {
    if (result instanceof Error) socket.emit('error', result);
    else socket.emit('connect');
  });
  return socket;
}

test('frame decoder handles fragmented and coalesced messages', () => {
  const received = [];
  const decoder = new FrameDecoder((message) => received.push(message));
  const first = encodeMessage({ type: 'event', value: 1 });
  const second = encodeMessage({ type: 'event', value: 2 });

  decoder.push(first.subarray(0, 2));
  decoder.push(Buffer.concat([first.subarray(2), second]));

  assert.deepEqual(received.map((message) => message.value), [1, 2]);
});

test('encoder rejects oversized messages', () => {
  assert.throws(() => encodeMessage({ value: 'x'.repeat(MAX_MESSAGE_BYTES) }), /outside the allowed size/);
});

test('decoder rejects zero and oversized frames before parsing', () => {
  const decoder = new FrameDecoder(() => assert.fail('message should not be emitted'));
  assert.throws(() => decoder.push(Buffer.alloc(4)), /frame size/);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(MAX_MESSAGE_BYTES + 1);
  assert.throws(() => decoder.push(oversized), /frame size/);
});

test('transport retries while a newly spawned helper creates its named pipe', async () => {
  const unavailable = Object.assign(new Error('pipe not created yet'), { code: 'ENOENT' });
  const sockets = [];
  const transport = new HelperTransport({
    pipeName: 'starting-helper',
    socketFactory: () => {
      const socket = fakeSocket(sockets.length === 0 ? unavailable : 'connect');
      sockets.push(socket);
      return socket;
    },
  });
  transport.request = async () => ({ protocolVersion: 1 });

  await transport.connect(500);

  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].destroyed, true);
  assert.equal(transport.socket, sockets[1]);
  transport.close();
});

test('transport does not retry a permanent pipe connection error', async () => {
  const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
  let attempts = 0;
  const transport = new HelperTransport({
    pipeName: 'denied-helper',
    socketFactory: () => {
      attempts += 1;
      return fakeSocket(denied);
    },
  });

  await assert.rejects(transport.connect(500), (error) => error.code === 'EACCES');
  assert.equal(attempts, 1);
});
