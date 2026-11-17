'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../recorder/session-catalog');
const { CallPipeline } = require('../recorder/call-pipeline');
const { CallService } = require('../recorder/call-service');
const { fresh } = require('../recorder/call-store');
const { SESSION, tempRoot, writeSession } = require('./helpers');

const V1 = '9b918241-3cb0-447c-8861-8f14358563e7';
const BROKEN_V1 = '11111111-2222-4333-8444-555555555555';
const DAMAGED = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function service(root, status = { state: 'idle', sessionId: null }) {
  const pipeline = new CallPipeline({ root, http: null, live: () => null, setTimer: () => null, clearTimer: () => {} });
  const supervisor = { status, snapshot: () => ({ ...status, levels: {}, build: 'test' }) };
  return new CallService({ root, pipeline, supervisor });
}

function writeV1(root) {
  const dir = path.join(root, V1);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sessionId: V1, protocolVersion: 1, state: 'stopped',
    startedAtUtc: '2026-09-15T09:00:00.000Z', durationMs: 1320000, tracks: [], segments: [] }));
  fs.writeFileSync(path.join(dir, 'processing.json'), JSON.stringify({ version: 1, sessionId: V1, state: 'complete',
    transcript: { text: 'Me: old call\nThem: still readable', segments: [] } }));
  const broken = path.join(root, BROKEN_V1);
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'manifest.json'), '{ not json');
}

test('older v1 recordings list read-only with their stored transcript; broken ones do not crash the list', async (t) => {
  const root = tempRoot(t);
  writeV1(root);
  writeSession(root, { frames: 30000 * 16 });
  fs.writeFileSync(path.join(root, SESSION, 'call.json'), JSON.stringify({ ...fresh(SESSION, { transcribe: true }), stage: 'complete',
    finalFrames: 30000 * 16, transcript: { windows: [{ index: 0, text: '', utterances: [{ speaker: 'me', startMs: 0, endMs: 900, text: 'new' }] }] } }));
  writeSession(root, { id: DAMAGED, frames: 16000 });
  fs.writeFileSync(path.join(root, DAMAGED, 'call.json'), '{"version":2,"sessionId":"nope"}');
  fs.mkdirSync(path.join(root, 'not-a-session'));

  const calls = await service(root).list();
  assert.deepEqual(calls.map(c => [c.sessionId, c.chip.label]), [
    [SESSION, 'Ready'], [DAMAGED, 'Failed'], [V1, 'Older recording'], [BROKEN_V1, 'Older recording'],
  ]);
  assert.equal(calls.find(c => c.sessionId === V1).durationMs, 1320000);

  const old = await service(root).get(V1);
  assert.equal(old.legacy, true);
  assert.equal(old.canRename, false);
  assert.deepEqual(old.items.map(i => [i.speaker, i.text]), [['me', 'old call'], ['them', 'still readable']]);
  const broken = await service(root).get(BROKEN_V1);
  assert.deepEqual(broken.items, []);
  assert.equal(await catalog.sessionKind(root, V1), 'v1');
});

test('session.json is validated; the audio file length is the authority on committed frames', async (t) => {
  const root = tempRoot(t);
  writeSession(root, { state: 'recording', frames: 1000, extraBytes: 3 });
  const session = await catalog.readSession(root, SESSION);
  assert.equal(session.state, 'recording');
  assert.equal(await catalog.audioFrames(root, SESSION), 1000);
  const file = path.join(root, SESSION, 'session.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), sampleRate: 48000 }));
  await assert.rejects(catalog.readSession(root, SESSION), (error) => error.code === 'invalid-session');
});

test('links inside a recording folder are refused', { skip: process.platform === 'win32' }, async (t) => {
  const root = tempRoot(t);
  writeSession(root, { frames: 16 });
  const outside = path.join(root, 'outside.pcm');
  fs.writeFileSync(outside, Buffer.alloc(64));
  fs.rmSync(path.join(root, SESSION, 'audio.pcm'));
  fs.symlinkSync(outside, path.join(root, SESSION, 'audio.pcm'));
  await assert.rejects(catalog.audioPath(root, SESSION), (error) => error.code === 'invalid-path');
  await assert.rejects(catalog.sessionDir(root, '../etc'), /sessionId is invalid/);
});

test('diagnostics carry session.json and call.json but never transcript text', async (t) => {
  const root = tempRoot(t);
  writeSession(root, { frames: 16000 });
  fs.writeFileSync(path.join(root, SESSION, 'call.json'), JSON.stringify({ ...fresh(SESSION, { transcribe: true }), stage: 'complete',
    transcript: { windows: [{ index: 0, text: 'secret words', utterances: null }] } }));
  const report = JSON.parse(await service(root).diagnostics(SESSION));
  assert.equal(report.session.format, 'kern-call-audio/1');
  assert.deepEqual(report.call.transcript, { windows: 1 });
  assert.equal(report.audioFrames, 16000);
  assert.doesNotMatch(JSON.stringify(report), /secret words/);
});
