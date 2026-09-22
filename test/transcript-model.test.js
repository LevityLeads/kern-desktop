'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConversation, toMarkdown, toPlainText, GAP_TEXT } = require('../recorder/transcript-model');
const { legacyTranscript, normalizeWindowTranscript } = require('../recorder/transcript-window');

const u = (speaker, startMs, endMs, text) => ({ speaker, startMs, endMs, text });
const turns = (items) => items.map((item) => (item.kind === 'gap' ? ['gap', item.startMs] : [item.speaker, item.startMs, item.endMs, item.text]));

test('utterances concatenate across windows in index order and merge same-speaker runs under 2 s', () => {
  const windows = [
    normalizeWindowTranscript({ text: '', utterances: [u('them', 58000, 59500, 'so the plan'), u('them', 60200, 61000, 'is simple')] }, 1),
    normalizeWindowTranscript({ text: '', utterances: [u('me', 0, 1000, 'Hi'), u('me', 2500, 3000, 'there'), u('them', 3100, 4000, 'Hello'),
      u('me', 6100, 7000, 'Right')] }, 0),
  ];
  assert.deepEqual(turns(buildConversation(windows)), [
    ['me', 0, 3000, 'Hi there'],
    ['them', 3100, 4000, 'Hello'],
    ['me', 6100, 7000, 'Right'],
    ['them', 58000, 61000, 'so the plan is simple'],
  ]);
});

test('a same-speaker pause of 2 s or more starts a new turn', () => {
  const window = normalizeWindowTranscript({ utterances: [u('me', 0, 1000, 'One'), u('me', 3000, 3500, 'Two')] }, 0);
  assert.equal(buildConversation([window]).length, 2);
});

test('a window that failed to transcribe shows as a quiet gap, and the call still reads on', () => {
  const windows = [
    normalizeWindowTranscript({ utterances: [u('me', 0, 1000, 'Before')] }, 0),
    normalizeWindowTranscript({ text: '', utterances: [], error: 'transcription_failed' }, 1),
    normalizeWindowTranscript({ utterances: [u('them', 120500, 121000, 'After')] }, 2),
  ];
  const items = buildConversation(windows);
  assert.deepEqual(turns(items), [['me', 0, 1000, 'Before'], ['gap', 60000], ['them', 120500, 121000, 'After']]);
  assert.match(toPlainText(items), new RegExp(GAP_TEXT.replace(/[[\]]/g, '\\$&')));
});

test('older windows: word segments group into turns by speaker and pauses over 1.5 s', () => {
  const window = normalizeWindowTranscript({ text: 'ignored', segments: [
    { speaker: 'me', startMs: 0, endMs: 400, text: 'Can' }, { speaker: 'me', startMs: 500, endMs: 900, text: 'you' },
    { speaker: 'me', startMs: 1000, endMs: 1300, text: 'hear' }, { speaker: 'them', startMs: 1400, endMs: 1800, text: 'Yes' },
    { speaker: 'them', startMs: 4000, endMs: 4300, text: 'Loud' },
  ] }, 0);
  assert.deepEqual(turns(buildConversation([window])), [
    ['me', 0, 1300, 'Can you hear'], ['them', 1400, 1800, 'Yes'], ['them', 4000, 4300, 'Loud'],
  ]);
});

test('plain text falls back to Me:/Them: lines, and v1 stored transcripts still render', () => {
  const window = normalizeWindowTranscript({ text: 'Me: Morning\nThem: Hi Rees\nno label here' }, 2);
  assert.deepEqual(turns(buildConversation([window])), [
    ['me', 120000, 120000, 'Morning'], ['them', 120000, 120000, 'Hi Rees'], [null, 120000, 120000, 'no label here'],
  ]);
  const legacy = legacyTranscript({ text: 'whole call', segments: [{ startMs: 0, endMs: 900, text: 'whole call' }] });
  assert.deepEqual(turns(buildConversation(legacy)), [[null, 0, 900, 'whole call']]);
  assert.equal(legacyTranscript('nonsense'), null);
});

test('copy formats: labelled plain text and escaped Markdown', () => {
  const items = buildConversation([normalizeWindowTranscript({ utterances: [u('me', 65000, 66000, 'Price is *5* # items'), u('them', 70000, 71000, 'OK')] }, 1)]);
  assert.equal(toPlainText(items, { heading: 'Acme call' }), 'Acme call\n\n[01:05] You: Price is *5* # items\n[01:10] Them: OK');
  assert.equal(toMarkdown(items, { title: 'Acme call', subtitle: '12 min' }),
    '# Acme call\n\n*12 min*\n\n**You** (01:05): Price is \\*5\\* \\# items\n\n**Them** (01:10): OK');
});

test('untrusted window transcripts are rejected, not guessed at', () => {
  assert.throws(() => normalizeWindowTranscript({ utterances: [u('narrator', 0, 1, 'x')] }, 0));
  assert.throws(() => normalizeWindowTranscript({ utterances: [u('me', 10, 5, 'x')] }, 0));
  assert.throws(() => normalizeWindowTranscript({ text: 7 }, 0));
  assert.throws(() => normalizeWindowTranscript({ text: '' }, 240));
  assert.throws(() => normalizeWindowTranscript({ text: '', error: { html: '<b>' } }, 0));
});
