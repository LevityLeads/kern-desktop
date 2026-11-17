# Call Recorder Finish Implementation Plan

> **For agentic workers:** Execute with the subagent-driven-development skill (default) or executing-plans (inline fallback), under test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every external call gets recorded with one click, and its summary, "read between the lines" subtext report and a transcript link land in one Kern thread.

**Architecture:** Four repos, five phases, each shippable alone. kern-desktop (Electron + .NET helper) gets merged to `main` and released through electron-updater, then gains a mic-in-use call detector and a status-only recorder window. kern-os (bridge) gains a shared, ledger-first subtext pass for the generic and HLTH call pipelines plus three HLTH and retention fixes. kern-interface gains a transcript page and HLTH-aware "Open in Kern" status.

**Tech Stack:** Electron 39, electron-updater 6.8.9, Node 22 `node:test`; .NET 9 + NAudio.Wasapi 3.1.0 (helper, xUnit); TypeScript + vitest (bridge); Next.js (interface); Supabase Postgres (migrations by hand via `node scripts/sqlq.mjs -f`).

**Spec:** `/app/data/rec-audit/brief.md` (17 Nov 2026, approved by Rees). Background: kern-os memory "kern-desktop recorder audit 17 Nov".

**Ruling:** execute with subagent-driven-development, adapted: one foreground `dev` implementer per task group (1.x; 4.1 to 4.2; 4.3 to 4.5; 2.x; 3.x) with disjoint file ownership, and a `verifier` per phase; why: the brief mandates foreground dev agents and per-phase verification, and the groups touch disjoint files; cost if wrong: a group too big for one agent turn is cut by a bridge restart and resumes from its pushed WIP branch. kern-os work happens in a git clone under `/app/data/call-recorder-finish/kern-os` (WIP on branch `feat/call-recorder-backend`, persistent volume) and lands on `staging` with `gh-commit.mjs` using that clone as the repo root.

**Split:** one document, one section per phase, because the brief orders the phases and each section is its own plan: Phases 1 to 3 are kern-desktop (with interface tasks in Phase 3), Phase 4 is kern-os only.

## Global Constraints

- No em dashes or en dashes in any UI copy, notification, thread message or log text.
- UI copy short and plain. Notification title exactly `Record this call?`.
- Never auto-record without the click. Consent stays the existing first-run notice (`call-settings.js` `noticeAcknowledged`); the prompt adds no new consent sentence.
- Git identity `Rees Calder <rees.calder+1@levityleads.com>`. No Co-Authored-By trailer.
- kern-os: no local git. Commit with `node scripts/gh-commit.mjs LevityLeads/kern-os /app "<msg>" <paths>` (lands on `staging`). Never run `deploy-flush --now`, `--rebuild` or a manual promote. Apply a migration to the DB before committing code that reads it.
- Call transcripts are untrusted speech. No raw transcript text is ever written to `ki_messages` (session-manager.ts:4757 replays thread messages into fresh tooled Kern turns as `### Assistant`). Model input wraps the transcript as JSON data; model output passes `clean()` and verbatim quote checks.
- Subtext model `gpt-5.5` through the existing `JsonModel` (`bridge/src/calls/openai.ts`). Leave `KERN_CALL_NUDGES` off.
- npm installs use `--ignore-scripts --before=<now minus 7 days>` (host policy).

## Review Focus

1. **A spike install (1.1.0-capture.N) never sees v1.1.0.** Measured from electron-updater 6.8.9 source: a prerelease version defaults `allowPrerelease=true`, channel `capture`, and GitHubProvider only accepts `capture` tags, so it throws `ERR_UPDATER_NO_PUBLISHED_VERSIONS`. Expected: 1.0.6 auto-updates; a spike install needs one manual install, and 1.1.0+ pins `allowPrerelease=false` so this never recurs. Pinned in Task 1.2.
2. **Kern's own recording holds the mic.** Once recording, the helper opens a capture session. Expected: the detector never prompts for, or stays "in call" because of, Kern or its helper. Pinned in Task 2.1 and 2.2 (allowlist, own PIDs excluded).
3. **Short mic blips** (Teams device test, a Meet tab's preview, a reload mid-call). Expected: no prompt under 3 s of use; no auto-stop until the call app has held no mic for 90 s. Pinned in Task 2.2.
4. **Teams transcript stops when a recording starts** (5 Nov: recap covered 11 of 50 min). Expected: the recording wins when it covers materially more. Pinned in Task 4.3.
5. **A crash between "report generated" and "message posted".** Expected: one subtext message, never two, and never a second model call. Pinned in Task 4.2.

---

## Phase 1: Merge and release v1.1.0 (kern-desktop)

### Task 1.1: Merge `main` into `feature/windows-call-capture`

**Files:** Modify: `main.js`, `package.json`, `electron-builder.yml`, `preload.js`, `.github/workflows/windows-capture-spike.yml`; keep main's `browsers.js`, `edit-menu.js`, `updater.js` and their tests.

- [ ] `git merge origin/main` (merge commit; the branch is pushed, never rebase).
- [ ] Resolve: `electron-builder.yml` `files` is the union (main's three modules plus `recorder/**/*`, `recorder-ui/**/*`). `package.json` keeps the branch's scripts and `package-lock.json`, version `1.1.0`.
- [ ] `main.js` updater: main's `updater.js` policy (4-hourly + resume, silent install when hidden) replaces the branch's one-shot `checkForUpdatesAndNotify`. It must keep `UpdateGuard`'s rule: never download-install or `quitAndInstall` while a capture is active. Add `isBusy: () => boolean` to `setupAutoUpdater` deps; `install()` and the hide-to-install path defer while `isBusy()` and retry when the recorder state goes idle. Fold `recorder/update-guard.js` into `updater.js` if that leaves one owner of updater policy; keep its tests' assertions.
- [ ] Spike workflow stamps `$(node -p "require('./package.json').version")-capture.<run>` instead of the literal `1.1.0`.
- [ ] Run `npm ci --ignore-scripts` (with the `--before` flag), `npm test`, and `dotnet test native/Kern.Recorder.sln -c Release` where dotnet exists. Expected: all pass.
- [ ] Commit, push, confirm the `windows-capture-spike` run on the head goes green (GitHub API `actions/runs?branch=feature/windows-call-capture`).

### Task 1.2: Pin the update channel

**Files:** Modify `updater.js`; Test `test/updater.test.js`.

- [ ] Failing test `pins stable channel`: after `setupAutoUpdater(deps)`, `autoUpdater.allowPrerelease === false` and `autoUpdater.channel` is not set to a prerelease channel.
- [ ] Failing test `does not install while recording`: `isBusy()` true, `update-downloaded` fires with the window hidden, `quitAndInstall` not called; flip `isBusy` false and signal idle, `quitAndInstall(true, true)` called once.
- [ ] Implement; tests pass; commit; push.

### Task 1.3: PR, merge, release

- [ ] Open PR `feature/windows-call-capture` -> `main` via GitHub API (title "Call recorder: merge capture branch, release 1.1.0"). Wait for the PR's Windows CI green. Merge (merge commit).
- [ ] Tag `v1.1.0` on the merge commit and push the tag (release.yml runs on `v*`). Wait for it green.
- [ ] Verify: GitHub release `v1.1.0` is non-draft, non-prerelease, has `Kern-Setup-1.1.0.exe`, `.blockmap`, `latest.yml`; `https://github.com/LevityLeads/kern-desktop/releases/latest/download/latest.yml` says `version: 1.1.0` and its `sha512`/`size` match the exe asset.
- [ ] Update-path check (scratch script, not in repo): run electron-updater 6.8.9's `GitHubProvider.getLatestVersion()` against the live feed with a stub updater for `1.0.6` (allowPrerelease false) and `1.1.0-capture.30` (allowPrerelease true, as the spike runs). Expected: 1.0.6 gets `1.1.0`; the spike gets `ERR_UPDATER_NO_PUBLISHED_VERSIONS`, which makes Rees's update a one-time manual install of `Kern-Setup-1.1.0.exe` if he runs the spike.

## Phase 2: Call-start prompt (kern-desktop)

**Mechanism decision.** WASAPI audio sessions, as fastrepl/anarlog does (MIT, `crates/detect/src/list/windows.rs`, 1 s poll): enumerate active capture endpoints, list sessions in state Active, map PID to process name. Chosen over the CapabilityAccessManager ConsentStore `LastUsedTimeStart/Stop` registry because sessions are live state per PID, need no registry key parsing for packaged versus NonPackaged apps, and NAudio already exposes them in our helper. ConsentStore stays the fallback only if hardware shows sessions missing a call app.

**Stop decision.** Auto-stop, not prompt-to-stop, for recordings started from the prompt: after the call app has held no mic for 90 s, stop and notify "Call ended. Recording stopped." Why: a stop prompt Rees misses (time blindness, walked away) records the room for hours; a false stop only splits one call into two saved recordings, each summarised. Manual recordings (Ctrl+Alt+R) are never auto-stopped.

### Task 2.1: Helper `--mic-watch` mode (.NET)

**Files:** Create `native/Kern.Recorder.Helper/MicWatch.cs` (loop + diff), `native/Kern.Recorder.Helper/MicSessions.cs` (NAudio enumeration behind `IMicSessionSource`); Modify `Program.cs` (argument dispatch); Test `native/Kern.Recorder.Helper.Tests/MicWatchTests.cs`.

**Produces:** stdout JSON lines, one per change plus a heartbeat every 30 s: `{"type":"mic","apps":[{"pid":1234,"name":"ms-teams"}]}`. Names are lower-case process names without `.exe`. The helper's own PID and its parent's are excluded. The process exits when its parent exits (reuse `ParentWatchdog`). A failure to enumerate one endpoint skips that endpoint; a whole-pass failure emits `{"type":"error","code":"enumerate-failed"}` and continues.

- [ ] Tests with a fake `IMicSessionSource`: emits on change only; excludes own and parent PID; heartbeat after 30 s of no change; per-endpoint failure does not drop other endpoints.
- [ ] Implement; `dotnet test` passes on CI (Windows); commit; push.

### Task 2.2: Detector state machine (Node)

**Files:** Create `recorder/call-detector.js`; Test `test/call-detector.test.js`.

**Produces:** `class CallDetector extends EventEmitter` with `update(apps: Array<{pid:number,name:string}>, nowMs: number)`; events `'call-started' {app: string}` and `'call-ended' {app: string}`. Constants `CALL_APPS = ['ms-teams','msteams','teams','zoom','chrome','msedge']`, `START_HOLD_MS = 3000`, `END_SILENCE_MS = 90000`.

- [ ] Tests: allowlisted app present for 3 s emits one `call-started`; present 2 s then gone emits nothing; non-allowlisted (`kern`, `kern.recorder.helper`, `discord`) never emits; after `call-started`, absence for 89 s emits nothing and 90 s emits one `call-ended`; reappearing at 60 s resets the end timer; one `call-started` per call (no repeat while the app holds the mic).
- [ ] Implement as a pure function of the snapshots and `nowMs`; tests pass; commit.

### Task 2.3: Watcher process, prompt, auto-stop, setting

**Files:** Create `recorder/mic-watcher.js` (spawns `helperPath --mic-watch`, parses lines, restarts on exit with backoff 2 s doubling to 5 min, stops on quit), `recorder/call-prompt.js` (glue); Modify `recorder/call-settings.js` (`callPrompt: true` default), `recorder/desktop-recorder.js` (wire), `recorder-ui/home.js` + `index.html` (one toggle "Ask to record when a call starts"), `main.js` (`app.setAppUserModelId('com.levityleads.kern')` before any Notification, Windows only); Test `test/call-prompt.test.js`, `test/mic-watcher.test.js`.

**Consumes:** `CallDetector` (2.2), the recorder's existing start path (`RecorderController` start with `transcribe` from settings), `supervisor.stop()`.

- [ ] Tests for `call-prompt.js` with fakes: `call-started` while idle and `callPrompt` on shows one Notification titled `Record this call?` with body `<App name> is using your microphone. Click to record.`; click starts recording once (double click starts once); `callPrompt` off shows nothing; already recording shows nothing; notice not acknowledged makes the click open the recorder window, not start; `call-ended` stops a prompt-started recording and shows `Call ended. Recording stopped.`; `call-ended` leaves a manual recording running.
- [ ] Tests for `mic-watcher.js`: malformed lines are ignored; exit restarts with backoff; `stop()` prevents restart.
- [ ] Display names: `ms-teams`/`msteams`/`teams` -> Teams, `zoom` -> Zoom, `chrome` -> Chrome, `msedge` -> Edge.
- [ ] Implement; `npm test` passes; commit; push; Windows CI green.
- [ ] Release `v1.2.0` (bump, tag, verify feed as in 1.3).

## Phase 3: One destination (kern-desktop, kern-interface, kern-os)

### Task 3.1: Transcript page and HLTH-aware status (kern-interface)

**Files:** Create `app/(app)/calls/[id]/page.tsx`; Modify `lib/calls/status.ts`; Tests next to the existing `lib/calls` tests.

- [ ] Page: owner-bound (same check as `app/api/calls/[id]/transcript`), renders each utterance as `[mm:ss] Me|Them: text` in plain React text (no markdown, no links), with a header (date, length) and a link back to the call thread when one exists.
- [ ] `kernThreadUrl`: generic summary posted -> its thread (unchanged); else the `hlth_calls` row with this `recording_id` and `posted_at` set -> its `ki_thread_id`. Test both and the "neither" case (null).
- [ ] PR, merge, verify the Vercel production deploy with `node /app/scripts/verify-deploy.mjs`.

### Task 3.2: Transcript link in the thread (kern-os)

**Files:** Modify `bridge/src/calls/summary.ts` `renderSummary(s, durationMs, recordingId)`, its caller in `summarizer.ts`, `bridge/src/hlth/calls/message.ts` (when the call has a `recording_id`); Tests `summary.test.ts`, the HLTH message test.

- [ ] Test: rendered summary ends with the line `Full transcript: [open](/calls/<recordingId>)` and contains no utterance text beyond verified quotes.
- [ ] Implement; `npx vitest run src/calls src/hlth/calls` passes; commit with gh-commit.

### Task 3.3: Status-only recorder window and one notification (kern-desktop)

**Files:** Modify `recorder/call-runner.js` (`complete()` stops downloading the transcript; `awaitSummary` fires `ctx.onSummary(state)` once, guarded by a persisted `summaryNotifiedAt`; raise `SUMMARY_WAIT_MS` to 4 h to cover HLTH Teams grace), `recorder/call-store.js` (field), `recorder/desktop-recorder.js` (replace the `Transcript ready` notification with `Call summary ready` / `Click to open it in Kern.`, click opens the thread via `openKernUrl`), `recorder-ui/call-view.js` and `recorder/call-view-model.js` (states Recording, Processing, Ready with an `Open in Kern` button); Delete transcript rendering (`recorder-ui/turns.js`, transcript parts of `transcript-model.js`/`transcript-window.js` that only serve it); Tests: update `call-pipeline.test.js`, `call-view-model.test.js`, `recorder-ui.test.js`.

- [ ] Tests: completion makes no transcript request; summary URL landing notifies once, and not again after a restart; the view model never exposes transcript text; `Open in Kern` appears only with a URL.
- [ ] Implement; tests pass; commit; push; CI green; release `v1.3.0` (or fold into `v1.2.0` if Phase 2 has not shipped yet).

## Phase 4: Backend (kern-os)

### Task 4.1: Subtext pass (pure module)

**Files:** Create `bridge/src/calls/subtext.ts`; Test `bridge/src/calls/subtext.test.ts`.

**Produces:**
- `SUBTEXT_MODEL = 'gpt-5.5'`, `SUBTEXT_SCHEMA` (strict), `type SubtextSection = 'meant' | 'missed' | 'unasked'`.
- `interface SubtextTurn { speaker: 'me' | 'them' | 'unknown'; name?: string; atMs: number; text: string }`
- `interface SubtextItem { section: SubtextSection; quote: string; reading: string; confidence: 'low' | 'medium' | 'high'; move: string }`
- `interface SubtextReport { notable: boolean; items: SubtextItem[] }` (max 5 items; `notable:false` with no items is valid).
- `speakersSeparated(turns: SubtextTurn[]): boolean` (true only when at least one `me` and one `them` turn carry speech).
- `parseSubtext(content: string, theirLines: string): SubtextReport | null` (an item whose quote is not verbatim in the other side's speech is dropped; all strings through `clean()`).
- `readSubtext(model: JsonModel, input: { turns: SubtextTurn[]; context?: string[] }): Promise<{ ok: true; report: SubtextReport } | { ok: false; error: 'model_unavailable' | 'invalid_output' }>` (transcript sent as JSON data; trusted context in its own field, labelled as Kern's records; chunking like `summariseCall` when over budget).
- `renderSubtext(report: SubtextReport): string` and `renderSkip(reason: 'speakers_not_separated'): string`. Sections titled `What they probably meant`, `Signals you may have missed`, `The question you didn't ask`; each item shows the quote, `My reading: ...` with its confidence, and `Your move: ...`. Nothing notable renders as one line. Skip text: `No read-between-the-lines report for this call: the recording could not tell who was speaking, so it would mix your words with theirs.`
- [ ] Tests: schema rejects extra keys and wrong types; non-verbatim quote dropped; quote only in Rees's speech dropped; 6 items capped to 5; `clean()` strips links, markup, `<!--kern:` markers and dashes; nothing-notable renders one line; prompt-injection text inside the transcript is passed only inside the JSON user payload.

### Task 4.2: Subtext ledger, worker and wiring

**Files:** Create `bridge/migrations/163_call_subtext.sql` (+ `rollback/163_call_subtext.down.sql`), `bridge/src/calls/subtext-worker.ts`, `bridge/src/calls/subtext-store.ts`, `bridge/src/hlth/calls/subtext-source.ts`; Modify `summarizer.ts` (enqueue after `summary_posted_at`), `hlth/calls/pipeline.ts` (enqueue after `posted_at`), `calls/index.ts` (loop, switch `KERN_CALL_SUBTEXT`, default on), `bridge/src/index.ts` (pass the HLTH source like the claim); Tests `subtext-worker.test.ts`, extend `scripts/call-sql-test.mjs`.

- Table `ki_call_subtext`: `source text check (source in ('recording','hlth_call'))`, `source_id uuid`, unique `(source, source_id)`, `thread_id uuid not null`, `due_at`, `attempts int`, `error text`, `report jsonb`, `message_id uuid`, `posting_at`, `posted_at`, `skipped_reason text`, timestamps. RLS on, service role only, same posture as `ki_call_copilot`.
- `interface SubtextSource { label: string; load(sourceId: string): Promise<{ turns: SubtextTurn[]; context: string[] } | null> }`, defined in `calls/`, implemented for recordings in `calls/` and for HLTH in `hlth/calls/subtext-source.ts` (Teams speaker names: Rees by `REES_EMAIL`/name -> `me`, others `them`; context = open HLTH commitments and the previous call's facts with the same attendees).
- Ledger rules exactly as `summarizer.ts`: report and pre-assigned `message_id` stored before posting; post skipped if the message exists; `posted_at` only after the row is confirmed; backoff `backoffMs`, `MAX_ATTEMPTS` 12; skip line posted (once) when speakers are not separated.
- [ ] Tests: posts once across a simulated crash after generation (no second model call); skip path posts one line and no model call; HLTH and recording sources both enqueue exactly one row; model failure backs off.
- [ ] Apply 163 with `node scripts/sqlq.mjs -f bridge/migrations/163_call_subtext.sql`, then commit code and migration with gh-commit.

### Task 4.3: HLTH `decide()` prefers a materially fuller recording

**Files:** Modify `bridge/src/hlth/calls/spine.ts` (`DecideInput` gains `teamsCoverageMs: number | null`), `canonical.ts` (`resolve` computes Teams coverage from turn times and waits for an active recording after the call end); Test `spine.test.ts`, `pipeline.test.ts`.

- Rule: after the call end, with Teams found and the recording complete, `use_recording` when `recordingMs >= teamsCoverageMs + max(5 min, 25% of teamsCoverageMs)`; otherwise Teams (speaker names). With Teams found and a recording still active, wait (bounded by `GIVE_UP_MS`).
- [ ] Tests: 11 min Teams vs 50 min recording -> recording; 48 vs 50 -> Teams; recording active after end -> wait; no recording -> unchanged behaviour (all existing tests pass).

### Task 4.4: Double-post race in `claim.ts`

**Measured (17 Nov):** recordings `bd7b52ba` (generic 25 Sep 13:56:52Z, HLTH 14:01:56Z) and `1326c009` (generic 14:52:05Z, HLTH 14:52:57Z) were posted twice. `claim.ts` landed in commit `ca65e95` at 14:14Z that day, after the first post; nearest-start matching landed 29 Sep (`09bd92d`). Every HLTH recording since was `claimed:hlth`. **Inferred, to confirm:** both doubles predate the fixes; live races remain where the verdict is `free` but HLTH can still post later (`no_transcript` flipped back to pending, an ad-hoc `hlth_calls` row created after the summariser asked).

- [ ] Reproduce each live race in `claim.test.ts` / `pipeline.test.ts` before fixing. Fix so one recording yields one post: the summariser treats a recording as `pending` while an HLTH owner could still post, and the HLTH pipeline does not post a recap for a recording whose generic summary already posted (it links the existing thread instead, or the agreed equivalent, recorded in the commit message).
- [ ] Tests pass; commit.

### Task 4.5: Audio retention 7 days

**Files:** Create `bridge/migrations/164_call_audio_retention.sql` (+ rollback) redefining the function(s) that schedule `purge` with `interval '7 days'` (find the latest definition; 110 has `interval '24 hours'`); Modify `bridge/src/recordings/types.ts` comment; Test `scripts/call-sql-test.mjs`.

- [ ] Test: completing a recording schedules purge at 7 days; the bucket `ki-recordings` stays private (`public = false`).
- [ ] Apply, commit.

## Phase 5: Verification and handover

- [ ] `scripts/call-e2e.mjs` (kern-os): builds a synthetic stereo call (TTS speech, me on channel 0, them on channel 1, about 3 min), drives create, live windows, upload and finalize through the same RPCs the interface API uses, then polls until transcribed, summary posted and subtext posted. Asserts exactly one summary message, one subtext message and a transcript link in the thread, then deletes the test recording and archives the thread. Runs only after the batcher has deployed Phase 4.
- [ ] `verifier` agent per phase against diffs, CI runs, release assets and the e2e output.
- [ ] One ask to Rees: update the app (manual install if he runs the spike), take one real external call of 12+ minutes through the prompt, confirm the thread.
