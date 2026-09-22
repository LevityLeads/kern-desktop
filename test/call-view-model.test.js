'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callSummary, callView } = require('../recorder/call-view-model');
const { fresh } = require('../recorder/call-store');

const ID = '9b918241-3cb0-447c-8861-8f14358563e7';
const session = { startedAtUtc: '2026-09-22T10:00:00Z', committedFrames: 22 * 60000 * 16, state: 'stopped' };
const input = (patch = {}, extra = {}) => ({ sessionId: ID, kind: 'v2', session, state: { ...fresh(ID, { transcribe: true }), finalFrames: 22 * 60000 * 16, ...patch }, ...extra });

test('chips: Recording, Transcribing n/m, Ready, Needs sign-in, Failed, Waiting for internet', () => {
  assert.equal(callSummary(input({}, { live: { elapsedMs: 5000 } })).chip.label, 'Recording');
  assert.equal(callSummary(input({ stage: 'transcribing', cloud: { state: 'transcribing', windowCount: 22, transcribedWindows: 18, kernThreadUrl: null } })).chip.label, 'Transcribing 18/22');
  assert.equal(callSummary(input({ stage: 'complete' })).chip.label, 'Ready');
  assert.equal(callSummary(input({ stage: 'sign-in-required', error: { code: 'auth', message: 'x', retry: false } })).chip.label, 'Needs sign-in');
  assert.equal(callSummary(input({ stage: 'failed', error: { code: 'rejected', message: 'x', retry: false } })).chip.label, 'Failed');
  assert.equal(callSummary(input({ stage: 'publishing', error: { code: 'network', message: 'x', retry: true } })).chip.label, 'Waiting for internet');
});

test('after stop: "Finishing: uploading the last minute", then "Transcribing 18/22 min"', () => {
  const windows = Array.from({ length: 21 }, (_, i) => ({ uploaded: true, windowIndex: i }));
  assert.deepEqual(callView(input({ stage: 'publishing', windows })).progress, { label: 'Finishing: uploading the last minute', fraction: 21 / 22 });
  const transcribing = callView(input({ stage: 'transcribing', cloud: { state: 'transcribing', windowCount: 22, transcribedWindows: 18, kernThreadUrl: null } }));
  assert.equal(transcribing.progress.label, 'Transcribing 18/22 min');
  // Without the server's counts, progress still has a denominator and never sticks at 0/0.
  assert.equal(callView(input({ stage: 'transcribing' })).progress.label, 'Transcribing 0/22 min');
});

test('banners: one sentence and one fix', () => {
  assert.deepEqual(callView(input({ stage: 'sign-in-required', error: { code: 'auth', message: 'x', retry: false } })).banner.action, 'sign-in');
  assert.deepEqual(callView(input({ stage: 'failed', error: { code: 'cloud-failed', message: 'Kern could not transcribe this call.', retry: false } })).banner,
    { message: 'Kern could not transcribe this call.', action: 'retry' });
  assert.equal(callView(input({ stage: 'complete' })).banner, null);
  assert.equal(callView(input({}, { live: { elapsedMs: 1 }, state: { ...fresh(ID, { transcribe: true }), error: { code: 'auth', message: 'x', retry: false } } })).banner.message,
    'Sign in to Kern so this call gets transcribed.');
  assert.equal(callView(input({}, { state: null, damage: { code: 'invalid-state', message: 'x', retry: false } })).banner.action, 'retry');
});
