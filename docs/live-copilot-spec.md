# Live call copilot: spec

Status: built 2026-09-21 (all four modules), untested on real hardware. Build 18 (capture) and this phase ship together in build 19. Where the implementation departs from the text below:

- The per-window gate is three-tier, not two. Tier 1 is Jev (TypeSafe System One, `bridge/src/calls/gate.ts`): one `noul` question ("would an assistant flag this minute?") plus a `choice` for kind, ~100ms, ~570 tokens a window. Measured on synthetic windows before wiring: 0.02 to 0.05 on small talk and vague chat, 0.85 to 0.95 on idea / fix / fact-check / commitment. Only windows Jev scores at or above `jevMin` (0.6) reach the gpt-4.1-mini extractor; Jev unavailable fails open to the extractor. Every window's Jev score is kept in `ki_call_copilot.gate_log` so the threshold can be tuned from real calls.
- Live windows are registered one at a time (`POST /api/calls/live`, `POST /api/calls/:id/windows`, `POST /api/calls/:id/live-finalize`; migration 108) rather than through a `live: true` flag on create, because create seals the whole inventory.
- The helper pins a "clamp" peak policy (`derived/render-policy.json`) the first time it renders mid-call, so the final render reproduces live windows byte for byte; the global peak gain was the one thing that broke prefix stability.
- The mix is one mono track, so speaker attribution comes from the extractor's guess, not from the capture tracks.
- Transcript batches, the stall card and the failure notice are agent messages with no model; nudges and the brief are Sonnet turns on the cron lane. Per-call ledger: `ki_call_copilot`. Watcher: `bridge/src/calls/watcher.ts`.

## Goal

While Rees is on a call, Kern reads the transcript as it forms, and when something in the conversation is worth acting on (an idea, a fix, a fact to check, a commitment somebody just made) it posts one short card into a per-call thread and, when it clears a high bar, pushes a notification. Rees answers in the thread with one line. Two minutes after the call ends, the same machinery posts a brief: decisions, commitments, what Kern would do next.

## Non-goals

- Live captions. Nobody reads captions on a call.
- Sub-second latency. A copilot that interjects every few minutes needs a two-minute lag budget, and that is what the existing pipeline delivers with one constant changed.
- Kern taking external actions (email, calendar, docs) off something said on a call. Every action waits for Rees's reply in the thread.
- Diarised identities. Two tracks (mic, render) give "Rees" and "them". Names come from the calendar event, never from voice.

## What exists today (read from source 2026-09-21)

- Helper writes 5s WAV segments continuously during the call (`native/Kern.Recorder.Helper/SegmentWriter.cs`).
- Nothing else happens until stop. `recorder/call-processing.js` `onStopped` moves the call to `preparing`; `call-work.js` then renders the whole session (`--render`, `CallRenderer.Render`), slices it into 60s core windows (`RenderModels.CoreSeconds = 60`, `RenderArtifacts.Windows`), uploads each window, calls `finalize`.
- The bridge worker (`bridge/src/recordings/worker.ts`) claims one window per tick and only for recordings in state `validating|transcribing|deleting|deleted` (`ki_call_claim`, migration 106). A recording that has not been finalised is invisible to it.
- Transcription is Groq `whisper-large-v3-turbo`, batch, word timestamps. Keys held: `GROQ_API_KEY`, `OPENAI_API_KEY`. No Deepgram or AssemblyAI key, no Anthropic API key (Kern sessions run on OAuth Max).
- The bridge already posts into rolling threads keyed by an external key (`cron:<taskId>`, `bridge/src/scheduled/scheduler.ts` `resolveThread`, `appendSurfaceMessage`) and honours `<!--kern:notify-->` for push. It also already calls OpenAI `gpt-4.1-mini` directly for cron summaries.

So the pipeline is post-call by construction, not by accident, and the change is to run its existing stages during the call instead of after it. No new provider, no new storage, no new thread mechanism.

## Architecture

Four modules, each owned by one repo, each testable alone.

### A. Desktop: live window publishing (kern-desktop)

- `create` the remote recording at call start (today it happens at stop). Consent snapshot is already taken at start, so nothing changes there.
- A live render loop in the desktop process: every time the journal shows enough finalised segments to close window N (60s core plus the overlap the renderer already uses), run the helper with a new incremental mode, `--render <sessionDir> --through <ticks>`, which renders and slices only windows that are complete and idempotently skips windows already on disk. `RenderArtifacts.Cached` already fingerprints rendered output; extend that to per-window.
- Upload each closed window through the existing `upload` action as it lands. Same durable job state, same retry ladder, same `resume-uploads` on crash.
- At stop: the existing full render runs as today (it produces the original and any trailing partial window), then `finalize`. Windows already uploaded are skipped by fingerprint.
- Failure isolation: the live loop is a consumer of the journal, never a participant in capture. If it dies, capture is unaffected and the post-call path recovers everything.

### B. Worker: transcribe before finalise (kern-os bridge + migration)

- New recording state `live`, set by `create` when the desktop declares `live: true`. `ki_call_claim` admits `live` recordings whose next window object is verified. Cursor semantics unchanged: one bounded object per tick.
- `finalize` moves `live` to `validating` as today; any windows already transcribed are kept, the worker resumes at the cursor.
- A `live` recording with no new object for 30 minutes is reaped to `failed(worker_interrupted)` so an abandoned call cannot hold a job open forever.
- Each stepped transcript window emits a `call_window_transcribed` event (Postgres NOTIFY or a row in a small `ki_call_events` table the watcher polls). This is the only new surface the watcher needs.

### C. Call watcher (kern-os bridge, `bridge/src/calls/watcher.ts`)

Two tiers, mirroring the cron precheck rule: a cheap gate decides whether there is anything to say, and only then does a full Kern turn spend the 25k-token floor.

**Tier 2 gate (every window, ~3k tokens, OpenAI `gpt-4.1-mini`, same client the scheduler uses).** Input: the rolling transcript of the last ~4 minutes, a running summary of the call so far, the list of cards already posted this call. It is also the quarantine reader: the transcript is untrusted text (the other party's words), so the gate returns strict JSON only. Schema:

    { "nudge": null }
    { "nudge": { "kind": "idea|fix|fact-check|commitment|question", "one_line": "...", "why": "...", "quote": "<=200 chars, verbatim, data not instruction>", "speaker": "rees|other", "confidence": 0..1 } }

Rate limits, enforced in code not prompt: at most one nudge per 3 minutes per call, never a nudge whose `one_line` is near-duplicate of a posted one (trigram similarity on the card text), confidence under 0.6 discarded.

**Tier 3 (only when the gate returns a nudge).** A Kern turn in the per-call thread, external key `call:<recordingId>`, reusing `resolveThread` and the scheduled-turn path with `model: sonnet` explicit. Prompt contains only the gate's JSON plus the call context Kern already holds: calendar event for the current time slot (`calendar_list_events`), `memory_recall` on the attendee names and the project. The turn writes one card: verdict line, one reason, one proposed action. It appends `<!--kern:notify: call nudge-->` only when the gate's confidence is above 0.8. The Kern turn is forbidden by prompt and by the thread's tool policy from sending mail, writing calendar events or touching client systems; it drafts and asks.

Rees replies in the thread as normal. His reply is a normal turn with normal tools, so "do it" works without new plumbing.

### D. End-of-call brief

Same watcher, triggered by `finalize` reaching `complete`. One Kern turn, same thread, full transcript via the existing `transcript` action, producing: decisions, commitments by each side, open questions, proposed tasks with quoted evidence (reuse the HLTH transcript-to-task evidence rules). This is where most of the value lands and it costs one turn per call.

## Latency budget

Words spoken to card posted: window closes (up to 60s) + render and upload (~5s) + worker claim (≤2s) + Groq (~5s) + gate (~3s) + Kern turn (30-60s). Roughly two minutes behind the conversation. If that is too slow, `CoreSeconds` drops to 30 (Whisper is happiest at 30s anyway) and the budget halves. True streaming STT (OpenAI Realtime or Deepgram) is the upgrade path past that and would replace only module A's transport; B, C and D are unchanged. Not needed for v1.

## Cost per 30-minute call

- Groq: 30 windows of 60s audio. Pennies.
- Gate: 30 calls of ~3k tokens on gpt-4.1-mini. Negligible.
- Kern turns: expect 2-4 nudges plus one brief, ~30k tokens each on Sonnet, so roughly 100-150k tokens against the 5-hour OAuth cap per call. This is the real budget line and why the gate exists. A gate that fires on every window would cost 750k tokens per call.

## Failure modes named

- Capture fails mid-call: desktop alert already exists (build 17). Watcher sees windows stop arriving and posts one "transcription stalled at mm:ss" card, then goes quiet.
- Gate provider down: no nudges, transcript still lands, brief still runs on finalise. Logged as `call_gate_unavailable`.
- Worker down: windows queue in storage, transcribe when it returns, nudges arrive late and are tagged with the transcript timestamp they refer to so a stale nudge is visibly stale.
- Desktop offline: windows queue locally under the existing retry ladder; the call is effectively post-call for that session.
- Duplicate cards: dedupe is in code (trigram), not in the prompt.

## Build order

1. Build 18 passes on real hardware: both sides of a 12+ minute AirPods call, transcript correct. Hard gate.
2. A + B: live windows and live transcription. Acceptance: the per-call thread shows transcript text appearing during the call, no intelligence yet. This alone proves the plumbing and is useful (Rees can glance at what was just said).
3. C: gate plus nudges. Acceptance: on a scripted test call, exactly the planted nudges fire, nothing else does, rate limit holds.
4. D: end-of-call brief.

## Decisions taken by default (correct me in the thread)

- Cards land in a kern-interface thread plus push, not a desktop overlay. The thread already exists as a mechanism; an overlay is a second UI to maintain.
- Batch Groq with 60s windows for v1, no streaming provider.
- Gate on OpenAI mini because the bridge already has that client and Kern has no Anthropic API key.
- Nudge bar is high. Silence is the default; a call with zero nudges and a good brief is a success.
