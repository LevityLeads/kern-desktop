# Call capture v2

Status: implementation spec, 2026-09-22. Replaces the 5 s segment + offline render design (helper protocol 1).

## Why v1 is being replaced

Measured on the first real stereo call (recording `897ee9ee`, build 24, 22 min): the microphone channel was clean, but the playback ("them") channel was about 85% exact digital zeros. Audio survived only as single 10 ms packets every 37-112 ms, and stitching those packets back together still transcribed as nonsense, so the packets were dropped inside the helper, not mis-placed. v1 turned every non-contiguous packet into a new segment file, rewrote the whole session manifest per segment under one lock, and dropped packets once its 512-packet queue filled. The design had too many places for audio to disappear: QPC run anchoring, per-run segment files, a quadratic manifest, a separate render pass, and a 20+ field validation chain in between.

v2 has one rule: every source is converted to 16 kHz mono on arrival and summed into a two-lane mixer positioned by the wall clock. The mixer commits finished audio to one append-only file. Nothing else stands between capture and the file.

## Session layout

```
<session>/
  session.json   small, atomically replaced (write temp, flush, rename)
  audio.pcm      interleaved stereo int16 little-endian, 16 000 frames/s
```

- `audio.pcm` frame `i` is session time `i / 16000` s, where 0 is the moment `start` returned. Lane 0 (left) is everything the microphone heard ("me"). Lane 1 (right) is everything Windows played, except Kern itself ("them"). 4 bytes per frame, 230 MB per hour.
- The file only ever grows. Its length is the authority on how much audio exists: `committedFrames = floor(size / 4)`. After a crash, everything up to the last flush (at most ~2 s) is intact.
- `session.json`:

```json
{
  "format": "kern-call-audio/1",
  "sessionId": "<uuid>",
  "state": "recording | paused | stopped | interrupted",
  "startedAtUtc": "...",
  "endedAtUtc": null,
  "sampleRate": 16000,
  "channels": 2,
  "lanes": ["me", "them"],
  "committedFrames": 0,
  "producer": { "app": "1.1.0-capture.N+sha", "helper": "2.0.0.0", "protocol": 2 },
  "playbackMode": "all-apps | devices",
  "sources": [ { "id": "...", "lane": "me|them", "name": "...", "mode": "microphone|process-loopback|endpoint-loopback",
                 "state": "active|idle|recovering|failed", "message": null,
                 "stats": { "packets": 0, "inputFrames": 0, "outputFrames": 0, "gaps": 0, "gapFrames": 0, "lateFrames": 0, "resyncs": 0, "droppedFrames": 0 } } ],
  "pauses": [ { "startFrame": 0, "endFrame": null, "reason": "user|mute|suspend" } ],
  "failure": null
}
```

It is rewritten on start, every state change, and every 5 s while recording (never per packet).

## Helper (native/Kern.Recorder.Helper), protocol 2

Kept as is: `Program` pipe server entry, `HelperServer` framing and parent-only pipe check, `Protocol` framing, `ParentWatchdog`, `WindowsNative`, `AtomicFile`, `AudioDevices` enumeration and microphone resolution, `TimelineClock`.

Deleted: the `--render` CLI and every `Render*`/`CallRenderer*` file, `SegmentWriter`, `SessionStore`, `CapturePacketProcessor`, `PacketTimeline`, `CaptureTrack`, `RecorderRecovery`, `CaptureFence`, and their tests. The `recover` command goes too: the desktop reads `session.json` and the file size itself.

Commands (payloads strict, unknown properties rejected, as today): `hello`, `ping`, `list-devices`, `start`, `pause`, `resume`, `mute-mic`, `unmute-mic`, `suspend`, `stop`, `shutdown`.

- `start` payload: `{ sessionId, sessionPath, microphone: { mode: "default"|"device", deviceId? } }`. The excluded process is the `--parent-pid` the helper was launched with (the Electron main process), so Kern's own audio never lands in "them".
- `status` event, emitted every 500 ms while a session is active and on every change:

```json
{ "state": "recording", "sessionId": "...", "startedAtUtc": "...", "elapsedMs": 0, "committedFrames": 0,
  "micMuted": false, "playbackMode": "all-apps",
  "sources": [ { "id": "...", "lane": "me", "name": "Microphone (FIFINE K670)", "mode": "microphone",
                 "state": "active", "level": 0.0, "message": null, "stats": { } } ],
  "failure": null, "warning": null }
```

`level` is the peak of the most recent converted audio, 0..1. `warning` is one human sentence or null (for example "Microphone disconnected. Reconnecting."). Command responses return the same status shape.

### Sources

- Microphone: `WasapiRecorderBuilder().WithDevice(mic).WithSharedMode().WithEventSync()`, device mix format.
- Playback, preferred: process loopback, `WithProcessLoopback(parentPid, ProcessLoopbackMode.ExcludeTargetProcessTree).WithFormat(IEEE float 48 kHz stereo).BuildAsync()`. One stream of everything every app renders, on every device, minus Kern. This removes the "which playback device did Teams use" problem entirely (Windows 10 2004+).
- Playback, fallback when process loopback fails to activate: endpoint loopback on every active render endpoint, one source each, reconciled on device-change notifications. `playbackMode` says which is in use.
- A source that stops with an error, or whose device disappears, goes to `recovering` and is reopened every 2 s (microphone: the same selection, falling back to the default communications microphone if the chosen one is gone, with a warning). Nothing a source does can stop the session.

### Conversion (pure, unit-tested)

`SourceConverter`: packet bytes in the source `WaveFormat` (IEEE float 32, PCM 16/24/32, any channel count, extensible or not) to mono float by channel average, then to 16 kHz with one `NAudio.Dsp.WdlResampler` per source whose state persists across packets. Packets flagged `Silent` convert as zeros of the same length. Output length per packet varies by a sample; that is expected.

### Alignment (pure, unit-tested)

`StreamAligner`, one per source, keeps `cursor` (session frame at 16 kHz where this source's next sample goes). For a packet converted to `n` samples, received at callback time `T`:

1. `wallStart` = the packet's QPC time when WASAPI marked it trustworthy and it lies within `[T - 2 s, T]`; otherwise `T - n`. Converted to session frames.
2. First packet, or `wallStart - cursor > 0.25 s` (the source was idle or genuinely lost audio): `start = wallStart`. The skipped span stays silent. Count a gap.
3. `cursor - wallStart > 2 s` (the source has run far ahead of the wall clock): `start = wallStart`, count a resync.
4. Otherwise `start = cursor`. Contiguous audio is never split by jitter.
5. `cursor = start + n` after the mixer accepts it (the mixer may move `start` forward, see below).

### Mixer (pure, unit-tested)

`CallMixer` holds a float ring of two lanes covering `[committed, committed + 10 s)`.

- `Add(lane, start, samples)` sums into the ring and returns the actual start. A start before `committed` moves forward to `committed` and counts `lateFrames`: late audio is shifted, never discarded. Samples beyond the ring end are dropped and counted in `droppedFrames` (only reachable if the wall clock and a source disagree by more than ~8 s).
- `TakeCommitted(throughFrame)` returns the int16 interleaved frames for `[committed, throughFrame)` (float sum clamped to int16) and advances `committed`.
- Pause and mute set lane gates: while a lane is gated, `Add` for it is ignored and the committed audio is silence.
- One lock guards the mixer. Capture callbacks convert outside the lock and only sum inside it. No file I/O ever happens on a capture thread.

### Commit loop

A 200 ms timer takes `TakeCommitted(now - 1.5 s)` (the 1.5 s horizon lets late Bluetooth packets land in place) and appends it to `audio.pcm` with a buffered `FileStream`, flushed to disk every 2 s. `stop` commits through the stop instant, flushes, closes, and writes `session.json` with `state: "stopped"`. A write failure sets `state: "interrupted"` with the error in `failure`, stops sources, and reports it; the audio already on disk stays valid.

## Desktop

One pipeline, always live. There is no separate post-call path.

- On `start`: create the local session, then (if signed in) `POST /api/calls/live` to open the remote recording. Offline is fine: the uploader retries.
- Windows: core 60 s, 1 s overlap each side (unchanged geometry, `window-000123`). Window `k` covers frames `[max(0, k*960000 - 16000), (k+1)*960000 + 16000)`. It is ready to publish once `committedFrames >= end`. The last window, cut at stop, has `end = committedFrames`.
- A window is produced by reading that byte range from `audio.pcm` (zero-filled past EOF is impossible because we wait for committed frames) and prefixing a 44-byte canonical WAV header (PCM, 2 channels, 16 kHz, 16 bit). No helper involvement.
- Publishing a window: register (`POST /api/calls/:id/windows`), get a signed upload URL, upload, persist progress. A durable per-call state file records which windows are uploaded so a restart resumes exactly where it left off.
- On `stop`: publish the remaining windows including the final partial one, then `POST /api/calls/:id/live-finalize`. Poll for the transcript. When the transcript is stored, delete `audio.pcm`.
- After a crash or quit mid-call: on launch, any session whose `session.json` says `recording` or `paused` without a live helper becomes `interrupted` with `committedFrames` from the file size, then finishes publishing and finalizes the same way.

## Server

Unchanged contract except: the two-hour cap rises to four hours (240 windows). Transcript quality work in the bridge worker: per-channel silence gating before Groq, dropping segments whose audio energy is near zero, utterance-level Me/Them turns where short backchannels do not split the other speaker's turn, and the previous window's tail as the Groq `prompt`.

## Acceptance

- Native unit tests: converter (sine through 44.1/48 kHz, 1/2/6/16 channels, float/int16/int24/int32, silent flag), aligner (jitter, gaps, bursts with QPC, bursts without QPC, drift, garbage QPC), mixer (sum, clamp, late shift, ring overflow, gates), commit loop against an in-memory sink, and a soak test: two simulated sources, 100 packets/s each with random jitter and bursts, 30 simulated minutes, asserting zero dropped frames and exact sample totals.
- Desktop unit tests: window geometry and bytes from a synthetic `audio.pcm`, resume after restart, finalize after an interrupted session.
- On hardware (Rees): a 2-minute call on AirPods with the FIFINE mic; both lanes transcribe cleanly.
