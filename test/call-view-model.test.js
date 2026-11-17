'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callSummary, callView } = require('../recorder/call-view-model');
const { fresh } = require('../recorder/call-store');

const ID = '9b918241-3cb0-447c-8861-8f14358563e7';
const session = { startedAtUtc: '2026-09-22T10:00:00Z', committedFrames: 22 * 60000 * 16, state: 'stopped' };
const input = (patch = {}, extra = {}) => ({ sessionId: ID, kind: 'v2', session, state: { ...fresh(ID, { transcribe: true }), finalFrames: 22 * 60000 * 16, ...patch }, ...extra });

test('chips: Recording, Processing, Ready, Needs sign-in, Failed, Waiting for internet', () => {
  assert.equal(callSummary(input({}, { live: { elapsedMs: 5000 } })).chip.label, 'Recording');
  assert.equal(callSummary(input({ stage: 'transcribing', cloud: { state: 'transcribing', windowCount: 22, transcribedWindows: 18, kernThreadUrl: null } })).chip.label, 'Processing');
  assert.equal(callSummary(input({ stage: 'publishing' })).chip.label, 'Processing');
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

test('the view carries status only: no transcript text, and Open in Kern only once Kern has a thread', () => {
  const cloud = (kernThreadUrl) => ({ state: 'complete', windowCount: 22, transcribedWindows: 22, kernThreadUrl });
  const stored = { windows: [{ index: 0, text: 'secret words', utterances: null }] };
  const withoutUrl = callView(input({ stage: 'complete', cloud: cloud(null), transcript: stored }));
  const withUrl = callView(input({ stage: 'complete', cloud: cloud('https://kern.example.org/t/1'), transcript: stored }));
  assert.equal(withoutUrl.hasSummary, false);
  assert.equal(withUrl.hasSummary, true);
  assert.equal(callView(input({ stage: 'transcribing' })).hasSummary, false);
  for (const view of [withoutUrl, withUrl, callView(input({ stage: 'transcribing' })), callView(input({}, { live: { elapsedMs: 1 } }))]) {
    assert.equal(view.items, undefined);
    assert.doesNotMatch(JSON.stringify(view), /secret words|kern\.example\.org/);
  }
  assert.deepEqual(['recording', 'working', 'ready'], [
    callSummary(input({}, { live: { elapsedMs: 5000 } })).chip.kind,
    callSummary(input({ stage: 'transcribing' })).chip.kind,
    callSummary(input({ stage: 'complete' })).chip.kind,
  ]);
});
