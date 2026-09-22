'use strict';

// Pure: window transcripts in, the call's conversation out. Kept in the main process so the
// renderer only ever receives plain, already-validated turns to display.
//
// Preferred: `utterances` (absolute ms, speaker me|them), concatenated in window order and
// merged when the same speaker continues within 2 s. Older windows: word/phrase `segments`
// grouped into turns by speaker and pauses over 1.5 s, or plain `text` ("Me: ..." lines).
const UTTERANCE_MERGE_MS = 2000;
const SEGMENT_TURN_GAP_MS = 1500;
const GAP_TEXT = '[a minute of audio could not be transcribed]';
const LABELS = { me: 'You', them: 'Them' };

function turn(speaker, startMs, endMs, text, source) {
  return { kind: 'turn', speaker, startMs, endMs, text: text.trim(), source };
}

function fromSegments(segments) {
  const turns = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === segment.speaker && segment.startMs - last.endMs <= SEGMENT_TURN_GAP_MS) {
      last.text = `${last.text} ${text}`;
      last.endMs = Math.max(last.endMs, segment.endMs);
    } else {
      turns.push(turn(segment.speaker, segment.startMs, segment.endMs, text, 'segments'));
    }
  }
  return turns;
}

function fromText(text, startMs) {
  const turns = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(me|them)\s*:\s*(.*)$/i.exec(line);
    const speaker = match ? match[1].toLowerCase() : null;
    const body = (match ? match[2] : line).trim();
    if (body) turns.push(turn(speaker, startMs, startMs, body, 'text'));
  }
  return turns;
}

function windowItems(window) {
  if (window.error) return [{ kind: 'gap', startMs: window.index * 60000 }];
  if (window.utterances) {
    return window.utterances.filter(u => u.text.trim()).map(u => turn(u.speaker, u.startMs, u.endMs, u.text, 'utterances'));
  }
  if (window.segments && window.segments.length) return fromSegments(window.segments);
  return fromText(window.text || '', window.index * 60000);
}

// windows: normalized window transcripts (transcript-window.js), any order.
function buildConversation(windows) {
  const ordered = [...(windows || [])].sort((a, b) => a.index - b.index);
  const items = [];
  for (const window of ordered) {
    for (const item of windowItems(window)) {
      const last = items[items.length - 1];
      if (item.kind === 'turn' && last?.kind === 'turn' && item.source === 'utterances' && last.source === 'utterances' &&
          item.speaker === last.speaker && item.startMs - last.endMs < UTTERANCE_MERGE_MS) {
        last.text = `${last.text} ${item.text}`;
        last.endMs = Math.max(last.endMs, item.endMs);
      } else {
        items.push({ ...item });
      }
    }
  }
  return items.map(({ source, ...item }) => item);
}

function timestamp(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function label(speaker) {
  return LABELS[speaker] || null;
}

function toPlainText(items, { heading = '' } = {}) {
  const lines = heading ? [heading, ''] : [];
  for (const item of items) {
    if (item.kind === 'gap') { lines.push(GAP_TEXT); continue; }
    const who = label(item.speaker);
    lines.push(`[${timestamp(item.startMs)}] ${who ? `${who}: ` : ''}${item.text}`);
  }
  return lines.join('\n');
}

// Transcript text is escaped so a spoken "#" or "*" never turns into Markdown structure.
function escapeMarkdown(text) {
  return text.replace(/([\\`*_{}[\]()#+\-.!|>~<])/g, '\\$1');
}

function toMarkdown(items, { title = 'Call', subtitle = '' } = {}) {
  const lines = [`# ${escapeMarkdown(title)}`];
  if (subtitle) lines.push('', `*${escapeMarkdown(subtitle)}*`);
  for (const item of items) {
    lines.push('');
    if (item.kind === 'gap') { lines.push(`*${escapeMarkdown(GAP_TEXT)}*`); continue; }
    const who = label(item.speaker);
    lines.push(`${who ? `**${who}** ` : ''}(${timestamp(item.startMs)}): ${escapeMarkdown(item.text)}`);
  }
  return lines.join('\n');
}

module.exports = { GAP_TEXT, buildConversation, label, timestamp, toMarkdown, toPlainText };
