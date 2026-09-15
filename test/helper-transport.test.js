'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameDecoder, MAX_MESSAGE_BYTES, encodeMessage } = require('../recorder/helper-transport');

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
