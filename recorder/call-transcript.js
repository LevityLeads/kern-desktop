'use strict';

const { fail } = require('./call-files');

async function downloadTranscript(api, prefix, durationMs) {
  const segments = [], texts = [];
  let after = -1, totalBytes = 0;
  const maxWindows = Math.ceil(durationMs / 60000);
  while (after < maxWindows - 1) {
    const page = await api(`${prefix}/transcript?after=${after}&limit=20`);
    if (!Array.isArray(page.windows) || page.windows.length < 1 || page.windows.length > 20) fail('protocol', 'Kern returned an incomplete transcript.');
    for (const window of page.windows) {
      if (window.window_index !== after + 1) fail('protocol', 'Kern returned an incomplete transcript.');
      const item = window.transcript;
      if (!item || typeof item.text !== 'string' || !Array.isArray(item.segments) || item.segments.length > 20000) fail();
      totalBytes += Buffer.byteLength(item.text);
      if (totalBytes > 1024 * 1024) fail('size', 'Transcript exceeds the local display limit.');
      texts.push(item.text);
      for (const s of item.segments) {
        if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || s.startMs < 0 ||
            s.endMs < s.startMs || s.endMs > durationMs + 1000 || typeof s.text !== 'string') fail();
        totalBytes += Buffer.byteLength(s.text);
        if (totalBytes > 1024 * 1024 || segments.length >= 100000) fail('size', 'Transcript exceeds the local display limit.');
        segments.push({ startMs: s.startMs, endMs: s.endMs, text: s.text });
      }
      after = window.window_index;
      if (after >= maxWindows) fail();
    }
  }
  const result = { text: texts.join('\n'), segments };
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) fail('size', 'Transcript exceeds the local display limit.');
  return result;
}
module.exports = { downloadTranscript };
