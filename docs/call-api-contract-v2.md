# Shared contract: desktop <-> Kern API for call capture v2 (2026-09-22)

Old desktop builds (<=24) must keep working: the sealed path (POST /api/calls, /upload in `uploading`, /finalize) stays.

New desktop flow (the ONLY flow the new desktop uses):
1. POST /api/calls/live {version:1, sessionId} -> {id, state:'live', sessionId, ownerId}. Idempotent: a repeat for the same sessionId and owner returns the existing recording (200) while it is still `live`.
2. For EVERY window, including the final partial one cut at stop, in index order:
   POST /api/calls/:id/windows {object} -> {id, objectId, windowIndex, windowCount}
   POST /api/calls/:id/upload {objectId} -> {signedUrl, ...}   (allowed while state is `live` or `uploading`)
   PUT signedUrl (a 400/409 "Duplicate" means already uploaded = success)
3. POST /api/calls/:id/live-finalize {version:1, sessionId, durationMs, objects:[all window objects]} -> 202 {id, state}
4. Poll GET /api/calls/:id; read GET /api/calls/:id/transcript (allowed in `live`, `validating`, `transcribing`, `complete`; returns whatever windows are transcribed so far).

Window object (unchanged shape): {id, kind:'window', sha256, byteLength, wav:{sampleRate:16000, channels:2, bitsPerSample:16, format:'pcm', frames}, windowIndex, startMs, endMs, coreStartMs, coreEndMs}
Geometry: core 60 s, 1 s overlap, all computed from the FINAL durationMs: coreStart = i*60000; start = max(0, coreStart-1000); coreEnd = min(durationMs, coreStart+60000); end = min(durationMs, coreEnd+1000). Mid-call the desktop only publishes window i once committed audio reaches coreStart+61000, so every window published during the call is "full" (end = coreEnd+1000). Windows cut after stop can be short: the last window always ends at durationMs, and the second-to-last is also short when durationMs < its coreEnd+1000 (e.g. durationMs=120500: window 1 = 59000..120500 core 60000..120000, window 2 = 119000..120500 core 120000..120500). So /windows cannot fully check geometry (durationMs is unknown until live-finalize): it must accept any window with start = max(0, coreStart-1000), coreEnd - coreStart in (0, 60000], coreEnd <= end <= coreEnd+1000, and reject overlaps with an already-registered different object for the same index. live-finalize then verifies every registered window against the formula with the real durationMs, that indices 0..n-1 are all registered and uploaded, and n = ceil(durationMs/60000). Frames = (endMs-startMs)*16, byteLength = 44 + frames*4. The desktop rounds committedFrames DOWN to a multiple of 16 before cutting after stop, so durationMs = frames/16 is an integer.
Limits: up to 240 windows (4 hours), durationMs <= 14,400,000.

GET /api/calls/:id adds (new desktop reads them if present, tolerates absence):
  transcribedWindows: number of windows with a stored transcript
  kernThreadUrl: string | null  (URL of the Kern thread holding the post-call summary, once posted)

Window transcript JSON (server writes; adapter 'groq-whisper-v2'):
{
  "adapter": "groq-whisper-v2",
  "silent": false,
  "text": "Me: ...\nThem: ...",          // turns within this window's core, kept for old desktops
  "utterances": [ {"speaker":"me"|"them", "startMs": <absolute call ms>, "endMs": <ms>, "text": "..." } ],
  "error": null | "transcription_failed"   // a window that failed after all retries: empty utterances, call still completes
}
Utterances include only those whose midpoint lies in [coreStartMs, coreEndMs) so adjacent windows never duplicate. Backchannels ("mm-hmm", "yeah", "okay") that sit inside the other speaker's turn are omitted from utterances. The desktop renders the call by concatenating utterances across windows in order and merging consecutive same-speaker utterances less than 2 s apart.

POST /api/calls/:id/retry -> 202 {id, state}: for a `failed` recording that is sealed, re-queue transcription of every window without a successful transcript. 409 call_conflict otherwise.
DELETE /api/calls/:id: unchanged (desktop "Delete call" uses it).
