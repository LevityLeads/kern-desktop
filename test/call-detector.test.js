'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CALL_APPS, CallDetector, END_SILENCE_MS, START_HOLD_MS } = require('../recorder/call-detector');

function rig() {
  const detector = new CallDetector();
  const events = [];
  detector.on('call-started', (e) => events.push(['started', e.app]));
  detector.on('call-ended', (e) => events.push(['ended', e.app]));
  return { detector, events };
}
const teams = [{ pid: 10, name: 'ms-teams' }];

test('constants match the plan', () => {
  assert.deepEqual([...CALL_APPS], ['ms-teams', 'ms-teams_modulehost', 'msteams', 'teams', 'zoom', 'chrome', 'msedge']);
  assert.equal(START_HOLD_MS, 3000);
  assert.equal(END_SILENCE_MS, 90000);
});

// New Teams moved its calling stack into a child process, ms-teams_modulehost.exe (Windows client
// update, January 2026), so during a call that process, not ms-teams.exe, holds the mic session.
test('new Teams calling host (ms-teams_modulehost) starts a call', () => {
  const { detector, events } = rig();
  const host = [{ pid: 11, name: 'ms-teams_modulehost' }];
  detector.update(host, 0);
  detector.update(host, 3000);
  assert.deepEqual(events, [['started', 'ms-teams_modulehost']]);
});

test('an allowlisted app holding the mic for 3 s starts one call', () => {
  const { detector, events } = rig();
  detector.update(teams, 0);
  detector.update(teams, 2999);
  assert.deepEqual(events, []);
  detector.update(teams, 3000);
  assert.deepEqual(events, [['started', 'ms-teams']]);
});

test('2 s of mic use then nothing emits nothing, and the hold timer restarts', () => {
  const { detector, events } = rig();
  detector.update(teams, 0);
  detector.update(teams, 2000);
  detector.update([], 2500);
  detector.update(teams, 4000);
  detector.update(teams, 6000);
  assert.deepEqual(events, []);
  detector.update(teams, 7000);
  assert.deepEqual(events, [['started', 'ms-teams']]);
});

test('Kern, its helper and non-allowlisted apps never emit', () => {
  const { detector, events } = rig();
  const apps = [{ pid: 1, name: 'kern' }, { pid: 2, name: 'kern.recorder.helper' }, { pid: 3, name: 'discord' }];
  for (let t = 0; t <= 600000; t += 1000) detector.update(apps, t);
  assert.deepEqual(events, []);
});

test('Kern holding the mic does not sustain a call', () => {
  const { detector, events } = rig();
  detector.update(teams, 0);
  detector.update(teams, 3000);
  for (let t = 4000; t <= 100000; t += 1000) detector.update([{ pid: 1, name: 'kern' }, { pid: 2, name: 'kern.recorder.helper' }], t);
  assert.deepEqual(events, [['started', 'ms-teams'], ['ended', 'ms-teams']]);
});

test('89 s of silence after a call starts emits nothing, 90 s emits one call-ended', () => {
  const { detector, events } = rig();
  detector.update(teams, 0);
  detector.update(teams, 3000);
  detector.update([], 3000 + 89000);
  assert.deepEqual(events, [['started', 'ms-teams']]);
  detector.update([], 3000 + 90000);
  assert.deepEqual(events, [['started', 'ms-teams'], ['ended', 'ms-teams']]);
  detector.update([], 3000 + 120000);
  assert.equal(events.length, 2);
});

test('the app coming back at 60 s resets the end timer', () => {
  const { detector, events } = rig();
  detector.update(teams, 0);
  detector.update(teams, 3000);
  detector.update([], 30000);
  detector.update(teams, 63000);
  detector.update([], 100000);
  detector.update([], 152000);
  assert.equal(events.length, 1);
  detector.update([], 153000);
  assert.deepEqual(events.at(-1), ['ended', 'ms-teams']);
});

test('one call-started per call while the app holds the mic', () => {
  const { detector, events } = rig();
  for (let t = 0; t <= 300000; t += 1000) detector.update(teams, t);
  assert.equal(events.length, 1);
});

test('a second call after the first ended starts again', () => {
  const { detector, events } = rig();
  detector.update(teams, 0); detector.update(teams, 3000);
  detector.update([], 3000 + 90000);
  detector.update(teams, 200000); detector.update(teams, 203000);
  assert.deepEqual(events.map((e) => e[0]), ['started', 'ended', 'started']);
});

test('names match case-insensitively and malformed snapshots are ignored', () => {
  const { detector, events } = rig();
  detector.update(null, 0);
  detector.update([null, {}, { pid: 1, name: 5 }], 1000);
  detector.update([{ pid: 4, name: 'Zoom' }], 2000);
  detector.update([{ pid: 4, name: 'Zoom' }], 5000);
  assert.deepEqual(events, [['started', 'zoom']]);
});
