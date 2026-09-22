'use strict';

const fs = require('node:fs');
const { safePath } = require('./call-files');

// The transcript is the product. Once it is stored locally, the audio has no further job: the 5 s
// capture checkpoints were only ever a crash log, and the rendered call file existed to be sliced
// into cloud windows. Both directories go; manifest.json (devices, counters, warnings) and
// processing.json (state, transcript) stay, so a bad call can still be diagnosed from its metadata.
const AUDIO_DIRECTORIES = ['segments', 'derived'];

async function pruneAudio(dir) {
  const removed = [];
  for (const name of AUDIO_DIRECTORIES) {
    // safePath refuses links and escapes; a missing directory is simply already pruned.
    const target = await safePath(dir, name, true);
    let stat;
    try { stat = await fs.promises.lstat(target); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory()) continue;
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    removed.push(name);
  }
  return removed;
}
module.exports = { pruneAudio, AUDIO_DIRECTORIES };
