# Plan: Guaranteed MSE preview load

Close the bake → fetch → append → play loop so a needed preview chunk cannot be skipped, dropped, or fail-opened away. Play only proceeds when that chunk is verified in `SourceBuffer.buffered`.

This is the Cursor draft. Superseded for execution by [PLAN-preview-playback.md](./PLAN-preview-playback.md). Codex draft: [PLAN-timeline-preview-reliability.md](./PLAN-timeline-preview-reliability.md). Debate: [NOTES-preview-plan-comparison.md](./NOTES-preview-plan-comparison.md). Lessons: [NOTES-timeline-preview.md](./NOTES-timeline-preview.md).

## Problem

A fragment can be baked to disk and still never play. Cache “ready” is optional after that: fetch/append is best-effort, a 400ms hole-skip can jump over a baked chunk, and a 3s stall abandons MSE for live decoders. That contradicts the NOTES rule that preview visuals come only from the fragment stream.

Do not load the whole timeline into MSE (quota). The guarantee is: every chunk the playhead needs is baked, fetched, appended, and verified before it is presented.

## Policy

Needed = covering fragment at the playhead, plus the next one (0.2s lookahead before the current chunk ends). Background pump still fills the 8s window; play never depends on “maybe it got appended.”

- If that covering chunk is baking or baked: hold (“Waiting for preview…”). Do not `skipHole` over it. Do not fail-open to live decoders.
- `skipHole` only when there is no covering bake. Prefer waiting if a bake is queued for that slot.
- If MSE is wedged (append errors, or baked but `covers()` stays false for a few seconds): reset MediaSource and re-append from cache. Stay on the preview stream.
- First picture as soon as the covering fragment is verified. Hold again near the chunk end if the next fragment is not verified yet. Continuity math uses SourceBuffer coverage, not the memory cache.
- Status distinguishes baking vs loading vs error. Keep the existing rebuild control.

## 1. Load tickets

File: `src/playback/mseFragmentPlayer.ts`

Replace opportunistic feed → fetch → maybe-enqueue with a per-fragment ticket keyed by `index + fingerprint`.

States: fetching → appending → verifying → loaded (or retry).

- Fetch failure: exponential backoff, keep the ticket. Do not wait for the engine’s 250ms re-feed.
- Append / SourceBuffer error / empty init-or-media / QuotaExceeded: requeue. Do not drop.
- Success only when `coversRange(interior)` is true. Bookkeeping is not enough.
- In-window tickets never silently disappear. Tickets outside the keep window may cancel.
- On cache notify / `sync({ feed: true })`, upsert tickets for every ready fragment in the window, covering first.

Engine-facing API:

- `covers(sec)` remains the source of truth for playable now.
- `isLoading(sec)` for status and “don’t skip.”
- `resetAndReload()` for the wedged-MSE path.

## 2. Engine hold and recover

File: `src/playback/timelinePlaybackEngine.ts`

Keep buffering until `mse.covers`. Cache-ready only means keep the load ticket hot — never a reason to skip or fail-open.

- Remove `PREVIEW_BUFFERING_FAIL_OPEN_MS` live-decoder fallback (`previewStreamDisabled`).
- If covering is baked or baking: never jump, never disable MSE.
- If covering is baked but `covers()` is false for ~2–3s: MSE reset + re-feed tickets.
- Continuity gate: if current is covered but next is not, and we are within `FRAGMENT_PLAYBACK_LOOKAHEAD_SEC` of the chunk end, hold picture and audio until the next ticket verifies. Use `fragmentPlaybackHasContinuity` against MSE coverage, not `cache.hasContinuity`.
- Cache subscribe already `resync("data")`. Tickets make that feed complete instead of a one-shot fetch-null.

Do not change audio-master clock, tfdt patch, or contiguous-buffer rules in NOTES.

## 3. Dual bake

File: `src/layouts/editor/timelineFragmentCache.ts`

Serial one-at-a-time bake stalls first play at every 2s boundary.

- Two concurrent bakes: playhead index and playhead+1 (priorities already exist).
- Debounce still applies to edits, not to “next slot while playing.”
- Keep fingerprint / `bakeEpoch` stale-drop. Failed bakes keep 4s backoff; the engine holds that slot until a later retry succeeds.

No new Tauri event bus. Invoke-return is bake completion. The gap is after that, in MSE.

## 4. Status copy

File: `src/layouts/editor/TimelinePane.tsx`

Distinguish “Baking preview…” (FFmpeg) vs “Loading preview…” (baked, ticket not verified) vs error + rebuild. Do not imply the picture is ready when only the disk cache is.

## 5. Tests

No `timelinePlaybackEngine` test file today. Add one with a fake cache + stubbed player:

- Covering fragment baked, `covers()` false → no `skipHole`, no `previewStreamDisabled`, stays buffering, keeps feeding.
- Next fragment not verified near chunk end → hold.
- Load wedge → MSE reset, not live fallback.

Player tests in `src/playback/mseFragmentPlayer.test.ts`:

- Fetch reject → ticket retries.
- Append error / appended true but buffered false → re-append until `coversRange`.
- Fragment leaves window → ticket cancelled; same fingerprint returns → new ticket.

Extend cache tests for two concurrent playhead / playhead+1 jobs.

## Done when

- Play and seek never present a video time whose covering fragment is unverified in `SourceBuffer.buffered`.
- A baked in-window fragment is fetched and appended until verified, or the user leaves that window. Fetch/append failures do not vanish.
- Hole-skip never jumps over a baking or baked covering chunk.
- Live-decoder fail-open is gone while the fragment cache is active.
- Wedged MSE recovers by reset + reload, still on the preview stream.
- Status is honest: baking vs loading vs error.
- Tests cover baked-but-not-loaded, retry, no skip/fail-open, dual bake, and continuity hold.

## Not this plan

- Codex’s Rust coordinator, SHA-256 manifests, revision state machine, or six-phase rewrite ([PLAN-timeline-preview-reliability.md](./PLAN-timeline-preview-reliability.md)).
- Loading every background bake into MSE.
- Scanning disk on mount (invoke + disk short-circuit is enough once the pump hits the slot).
- Changing tfdt patch, codec string, or audio-master clock.
- Removing `tauriEventGuard` (unrelated to fragments).
