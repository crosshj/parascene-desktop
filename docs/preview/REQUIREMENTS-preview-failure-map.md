# Requirements: preview failure map

Boundaries, invariants, assumptions, and enumerated failure modes for timeline preview. Normative for [PLAN-preview-playback.md](./PLAN-preview-playback.md): every F-number below must have a designed response and a test, or an explicit accepted-risk note. Codex: extend or attack this list in place; add F-numbers, do not renumber existing ones.

Response classes used below:

- retry — bounded retries on a real timer, then blocked
- reset — tear down and rebuild the MSE session, bounded, then blocked
- rebake — invalidate the artifact and demand a new encode
- depwait — dependency-waiting: hold last frame, badge, auto-resume
- blocked — terminal retryable state, playhead held, precise reason shown
- config — not transient; retrying cannot fix; name the misconfiguration
- fence — discard stale work; no user-visible effect

## Boundaries

- B1 React UI ↔ playback engine (props, callbacks, RAF ownership)
- B2 Engine ↔ fragment cache (plan, ready map, subscribe)
- B3 Cache ↔ Tauri invoke (bake RPC; return value is the only completion signal)
- B4 Rust ↔ FFmpeg child process
- B5 Rust ↔ disk cache (partials, rename, prune)
- B6 WebView fetch ↔ `media://` protocol (CSP, custom scheme)
- B7 Player ↔ MediaSource/SourceBuffer (async append queue)
- B8 SourceBuffer ↔ decoder/presentation (buffered says nothing about frames)
- B9 Baked-audio clock ↔ video element clock
- B10 App lifecycle ↔ all of the above (remount, hide, sleep/wake, restart)
- B11 Platform: WKWebView (macOS) vs WebView2 (Windows)

## Invariants

- I1 The clock never enters video time that is not verified in the active SourceBuffer.
- I2 Presented pixels always belong to the active generation (timeline revision + rendition).
- I3 The SourceBuffer contains only fragments of the active generation; rendition change means a new MediaSource.
- I4 Sequential demanded fragments form one continuous buffered range.
- I5 A demanded in-window fragment has a live ticket until verified or cancelled with a reason.
- I6 Every failure lands in exactly one state: retrying (with a wake timer) or blocked (with a reason). No silent drop.
- I7 Audio never runs while the picture is held.
- I8 Anything the ready map points at exists on disk and is structurally valid.
- I9 One writer per fragment file. Nothing reads a partial. Prune never deletes a leased path.
- I10 Displayed status equals actual state. Disk-ready is never shown as playable.

## Assumptions (each one is a latent failure)

- A1 MSE is supported and the codec string is accepted. Probe at startup; blocked (config) if not.
- A2 `media://` fetches pass CSP on both platforms.
- A3 FFmpeg binary exists and works.
- A4 Cache disk is writable with space.
- A5 The tfdt patch places every fragment exactly; encode fps never disagrees with planned duration.
- A6 32-bit FNV fingerprint collisions are negligible. Accepted risk until stage 3 identity.
- A7 Tauri invoke returns; IPC is not dropped.
- A8 RAF ticks while visible; wake timers must not depend on RAF (throttled when hidden).
- A9 Sleep/wake suspends timers and media elements incoherently; state must be revalidated on wake.
- A10 One editor session writes a project cache dir at a time.

## Failure modes

### Produce (B3, B4, B5)

- F1 FFmpeg exits non-zero. Detect: invoke rejects. Respond: retry with backoff + wake timer; budget exhausted → blocked.
- F2 FFmpeg hangs. Detect: none today — add bake deadline. Respond: kill process, retry.
- F3 Bake returns but file is missing or truncated (crash between write and rename). Detect: structural probe. Respond: rebake.
- F4 Bake completes for a stale fingerprint. Detect: fingerprint/epoch check (exists). Respond: fence.
- F5 Source asset not local. Detect: locality filter. Respond: depwait. Never a black “ready” fragment.
- F6 Two writers share a partial filename. Detect: cannot, today. Respond: prevent — unique partials + single-flight (stage 2).
- F7 Prune/clear deletes a file the session is fetching. Detect: fetch 404 after ready. Respond: prevent with leases; on 404 reconcile then rebake.
- F8 Disk full or permission denied. Detect: typed invoke error. Respond: blocked (config), actionable message.
- F9 Cache hit on a corrupt or wrong-duration file (existence-only check today). Detect: probe ftyp/moov/moof/mdat, timescale, tfdt, sample-clock duration. Respond: quarantine + rebake.

### Transfer (B6)

- F10 CSP blocks the fetch. Detect: fetch throws / res not ok on every attempt. Respond: config, not retry — retrying cannot fix CSP.
- F11 404 for a ready path. Detect: status. Respond: reconcile with producer, rebake.
- F12 Bytes are not a valid media fragment. Detect: fmp4 probe. Respond: one re-fetch, then rebake.
- F13 Fetch hangs. Detect: none today — add deadline + AbortController. Respond: retry.
- F14 Stale fetch resolves after generation change. Detect: generation token. Respond: fence.

### Load (B7)

- F15 SourceBuffer fires `error`. Detect: event (today it silently continues). Respond: requeue ticket; N failures → reset.
- F16 QuotaExceededError. Detect: exception. Respond: trim outside protected window, retry once, then reset.
- F17 Append “succeeded” but buffered does not cover the demanded range (tfdt wrong, boundary gap, engine trim). Detect: exact-range verify after updateend. Respond: this is a content bug, not a transfer bug — rebake, log loudly. Re-appending the same bytes loops forever.
- F18 Init segment missing or from another rendition. Detect: init tracking. Respond: reset with new MediaSource.
- F19 `sourceopen` never fires. Detect: deadline. Respond: reset.
- F20 `updateend` never fires. Detect: watchdog on pending append. Respond: reset.
- F21 Duplicate or overlapping append of the same fragment. Detect: ticket key. Respond: fence.
- F22 remove() under or just ahead of a playing playhead. Detect: n/a. Respond: prevent — protected window is never evicted.

### Verify / present (B8)

- F23 Buffered covers but no frame is presented (decode failure). Detect: `video.error`, rVFC timeout. Respond: reset; budget → blocked.
- F24 `play()` rejects. Detect: promise rejection. Respond: muted retry; persists → blocked with reason.
- F25 `waiting`/`stalled` inside a verified range. Detect: events. Respond: treat as lost coverage; recovery loop.
- F26 Seek lands somewhere other than the target. Detect: compare currentTime after `seeked`. Respond: re-apply; never accept a nearby time.
- F27 ~20ms boundary gap between sequential fragments. Detect: continuity check. Respond: same as F17 (content bug).

### Clock (B9)

- F28 Audio/video drift. Detect: monitor delta. Respond: snap video (existing rule; keep).
- F29 Audio starts before picture is admitted. Detect: n/a. Respond: prevent — admission holds audio (I7).
- F30 End-of-timeline wrap race between clocks. Detect: epsilon checks. Respond: explicit wrap path, both clocks reset together.

### Lifecycle (B10)

- F31 React remount / Strict Mode destroys the session. Respond: prevent — session hoisted; hide ≠ destroy.
- F32 Project, quality, or aspect switch with work in flight. Detect: generation token. Respond: fence + new MediaSource.
- F33 Edit dirties the fragment under a playing playhead. Respond: policy — keep playing stale pixels to the fragment boundary, swap behind the playhead; never yank the active range.
- F34 Sleep/wake. Detect: clock jump / visibilitychange. Respond: revalidate coverage and tickets; reset if wedged.
- F35 App restart. Respond: stage 3 manifest reconcile; until then, disk short-circuit re-pump is the accepted cost.
- F36 Hidden window throttles RAF so retries stop. Respond: prevent — ticket timers are setTimeout-based, not RAF-based.

### Platform (B11)

- F37 MSE unsupported or codec rejected. Detect: startup probe. Respond: blocked (config) with message. Never silent live decoders.
- F38 Engine-specific quota and eviction behavior (WKWebView vs WebView2). Respond: stage 4 matrix runs the full fault suite on both.
- F39 `media://` custom-scheme behavior differs on Windows. Respond: stage 4; F10/F11 detection must be platform-tested.

## Error kinds → response policy

The F-numbers above are incidents. Policy is decided one level up, by kind. Two questions classify every error: can retrying ever fix it, and who can act (system, user, developer). The kind dictates the machine response, the retry budget, and the surfacing tier — individual failure modes never invent their own policy.

| Kind | Nature | Machine response | Budget | Surfacing | F-numbers |
| --- | --- | --- | --- | --- | --- |
| K1 Stale | Expected result of an edit/switch; not an error | fence: discard silently | none needed | T0 forever, never escalates | F4, F14, F21, F32 |
| K2 Transient | Timing/load; same action can succeed | retry with backoff + jitter, wake timer | 5 attempts, 250ms → 8s; then treat as K3 | T0 → T1 after 2 failures → T3 on exhaustion | F1, F7, F11, F13, F15, F16 (trim first), F25, F26 |
| K3 Wedge | Engine state is stuck; the *session* is the problem | reset MediaSource, reload demand window | 3 resets per 60s; then blocked | T0 first reset → T1 → T3 | F18, F19, F20, F23, F24, F34 |
| K4 Content | Deterministic: the bytes are wrong; retrying identical bytes loops forever | rebake, never re-append the same artifact | 2 rebakes; identical second failure reclassifies as K7 | T0 first rebake → T1; K7 path → T3 | F3, F9, F12, F17, F27 |
| K5 Dependency | Waiting on something legitimately absent | depwait: hold last frame, auto-resume on arrival | unlimited, event-driven re-check | T1 badge for the duration; never T3 by time alone | F5, F35 |
| K6 Config | Environment is wrong; no retry can ever fix it | stop; name the fix; re-check only on user Retry or config change | 0 automatic retries | immediate T3, actionable message | F8, F10, F37 |
| K7 Bug | Invariant violated or "impossible" state; our code is wrong | hold, loud log with full context, copy-report affordance | never auto-loop | T3 with report; this is developer-facing by definition | F6, F22, F29 if ever observed; K4 repeats; any I1–I10 violation |

Rules the table implies:

- Budgets promote *between* kinds: exhausted K2 becomes K3 (the session, not the request, is now suspect); a repeated K4 becomes K7 (the producer is deterministically wrong — that is a bug, not bad luck).
- K6 must be distinguished from K2 at detection time. A CSP block looks like a failed fetch; burning five retries on it hides a config error behind a spinner. Every-attempt-identical failure with a config signature short-circuits to K6.
- K5 is the only kind allowed to wait forever, because it escalates on evidence (asset arrives or user acts), not on time.
- K7 never gets an automatic recovery loop. Looping on our own bug converts a visible defect into an invisible one.
- Prevented-by-design modes (F22, F28, F30, F31, F33, F36) have no runtime policy; if one is ever *observed*, it is K7 by definition.

## Failure surfacing

Precedent to reuse, not reinvent: [STANDARDS-sync-diagnostics.md](../STANDARDS-sync-diagnostics.md) (JSONL on disk via `library_append_diag_log`, console prefix, known-errors triage) and `uiDiagnostics.ts` / `UiDiagnosticsModal` (ring buffer + drill-in + copyable report).

Principle: the user sees state, the developer sees failure modes. The bridge is one click.

Surfacing tiers:

- T0 silent. Logged, no UI. All fences; a retry or reset that succeeds on early attempts.
- T1 passive. Subtle health indicator on the existing preview status pill (plus the depwait badge). No interruption. Hover gives one line; click opens the drill-in.
- T2 hold. Playhead held, monitor shows a state word (Loading…, Waiting for media…). This is status, not an error.
- T3 blocked. Retryable terminal state: precise reason, Retry, and Details linking to the drill-in. Config failures (F8, F10, F37) land here immediately with an actionable message — they must not burn quietly in the retry loop.

Escalation is automatic: repetition promotes (e.g. repeated resets inside a minute promote T0 to T1; budget exhausted promotes to T3). Recovery demotes silently, but the per-fragment error record persists in the log until that fragment recovers — an unrelated success never clears it.

Drill-in (preview health panel, UiDiagnosticsModal pattern):

- Ring buffer of recent preview events, each tagged F-number, fragment index, generation, attempt, response class.
- Live state: ticket table, buffered ranges vs demand window, clock delta, MediaSource readyState, reset count.
- Copy-report button producing one pasteable text block.

Developer / agent loop:

- JSONL at `Library/logs/preview.jsonl` — one object per T1+ event and per response-class transition: `{ts, f, fragment, generation, attempt, phase, detail}`.
- Console mirror prefixed `[preview]`. Today's verbose MSE/tfdt logging folds into this and stops being always-on (NOTES already wants it gone).
- A known-errors triage section (like the sync standard) mapping common `detail` strings to F-numbers and first checks. Agents read the disk log before theorizing.

## Known detection gaps today

No detection currently exists for: F2, F3 (probe missing), F6, F9, F13, F15 (event ignored), F17 (interior slop, not exact range), F19, F20, F23, F34. Stage 1 and 2 work is largely building these detectors; responses are meaningless without them.

## Accepted risks

- A6 fingerprint collisions until stage 3 identity.
- F35 restart cost until stage 3 manifest.
- Unrecoverable machine failure (disk death, WebView crash loop) ends in blocked, not playback.
