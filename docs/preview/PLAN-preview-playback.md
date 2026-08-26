# Plan: Preview playback

The execution plan. Supersedes the Cursor and Codex drafts as what we implement. Those drafts stay in this folder as history.

Sources: [PLAN-mse-preview-load-guarantee.md](./PLAN-mse-preview-load-guarantee.md), [PLAN-timeline-preview-reliability.md](./PLAN-timeline-preview-reliability.md), [NOTES-preview-plan-comparison.md](./NOTES-preview-plan-comparison.md), [NOTES-preview-plan-comparison-codex.md](./NOTES-preview-plan-comparison-codex.md), [PLAN-preview-reliability-recommendation.md](./PLAN-preview-reliability-recommendation.md). Lessons: [NOTES-timeline-preview.md](./NOTES-timeline-preview.md).

Normative failure map: [REQUIREMENTS-preview-failure-map.md](./REQUIREMENTS-preview-failure-map.md). Every stage below must close its F-numbers; responses and surfacing follow its K-kind policy table (K1 stale … K7 bug); stage 4 tests are written against them.

Goal: preview is closed enough that we stop thinking about it. Demanded fragments are produced, loaded, verified, and either played or held with a precise error. Failure never looks like playback.

FFmpeg, disk, and the webview (WKWebView on macOS, WebView2 on Windows) will still fail. Completeness means those failures cannot skip, snap, or fall back to live decoders.

## Settled

- Ready is not a returned disk path. Ready is the exact demanded range in `SourceBuffer.buffered`, then a presented frame.
- Kill skip-to-nearby-range and live-decoder fail-open in stage 1, not after a Rust coordinator.
- Play and seek start only when current and next fragments are verified (no next if this is the last picture fragment). Never snap a seek to a nearby buffer.
- Frontend generation/rendition token is enough for admission. Cryptographic artifact identity is producer work.
- No SHA-256 of every 2s local fragment unless later evidence of bitrot.
- Do not put preview encodes on the general `jobs.rs` FIFO. Manifest plus dedicated preview scheduling.
- New MediaSource on quality / aspect / rebuild. Defer a shared-init muxer redesign.
- Intentional empty picture may be black. A clip whose asset is not local is dependency-waiting: hold the last presented frame with a subtle warning badge, resume automatically when the asset arrives. Never admit it as ready.
- jsdom is policy tests only. Packaged macOS (WKWebView) and Windows (WebView2) are the gate to “done.” MSE behavior differs across the two engines; both must pass.
- Audio stays master after admission. Keep the `tfdt` patch. Do not load the whole timeline into MSE.

## Promise

At every video timestamp, show the exact fragment for the active generation or hold on that time.

`ensurePlayableWindow(sec)` is the only admission API. The clock cannot enter unverified video time.

Status is baking, loading, or blocked. Playhead-ready means verified in the SourceBuffer, not disk-ready.

Recovery is one bounded, observable loop:

1. Detect missing coverage, append error, quota error, fetch timeout, or stalled playback.
2. Stop admission at the affected boundary. Keep the last presented frame.
3. Abort stale work, reset the MSE session, reload the exact demand window.
4. Retry with backoff and a visible status.
5. Retry budget exhausted: retryable blocked state. Never jump, never deadlock, never live decoders.

## Stage 1 — Admission

Frontend. Current bake invoke kept. Delete the dangerous paths now.

- `ensurePlayableWindow(sec)`: covering range and next range verified before Play or Seek may roll. Last picture fragment needs no next.
- Durable load tickets with a wake timer. Fetch/append retry does not wait for a playhead move or remount.
- Success is exact start/end coverage of the demanded interval, plus continuity into the next, not an `appended` map or `coversRange(interior)` slop.
- Generation token on every fetch, queue item, and append. Discard stale. New MediaSource on quality, aspect, or refresh.
- Delete `skipHole` jumps over missing time. Delete `PREVIEW_BUFFERING_FAIL_OPEN_MS` live fallback.
- Seek stays pending until the target window verifies. It never snaps.
- MSE reset + reload on wedge. Cap attempts, then blocked with Retry. Hold time. No live decoders.
- Hoist MSE/session lifetime off the timeline-monitor React branch. Hide ≠ destroy.
- Handle `play()` rejection, `video.error`, `waiting` / `stalled`. Prefer `requestVideoFrameCallback` (or equivalent) before calling a range presented.
- Status copy: baking vs loading vs blocked.
- Failure surfacing per the tiers in the failure map: silent log, passive health dot, hold, blocked. JSONL to `Library/logs/preview.jsonl` (reuse `library_append_diag_log`), `[preview]` console prefix, drill-in health panel on the UiDiagnosticsModal pattern. Fold today's verbose MSE logging into it.

Files: `src/playback/mseFragmentPlayer.ts`, `src/playback/timelinePlaybackEngine.ts`, `src/playback/useTimelinePlaybackEngine.ts`, `src/layouts/editor/EditorLayout.tsx`, `src/layouts/editor/PreviewPane.tsx`, `src/layouts/editor/TimelinePane.tsx`.

## Stage 2 — Demand and producer hygiene

Still mostly current files. Stops loading the wrong file.

- Play/Seek demand covering+next immediately. Bypass edit debounce for those slots only. Background pump still fills the keep window.
- Concurrent bakes of demanded slots. Unique partial filenames. Single-flight per fragment id.
- Do not prune or clear a path the session may still fetch. Atomic publish after flush/rename.
- Bake backoff has a real wake timer.
- Missing source asset is not a successful black fragment. Locality re-plan. Do not admit it.
- Cache hit is not “file exists.” Probe nonempty `ftyp/moov/moof/mdat`, video track, timescale, `tfdt`. Quarantine and rebuild on mismatch.
- Two concurrent bakes land only after unique partials exist. Do not add parallelism onto a shared `*.partial.mp4`.

Files: `src/layouts/editor/timelineFragmentCache.ts`, `src-tauri/src/library/timeline_fragments.rs`.

## Stage 3 — Durable producer identity

Rust owns plan identity and disk truth. After stages 1–2 are default.

- Rust canonicalizes plan, encode schema, fragment id. FE stops owning `PREVIEW_ENCODE_TAG` as source of truth.
- Compact manifest/snapshot of verified files. Remount discovers work without re-baking. Events optional; snapshot is the safety net.
- Validate duration from the sample clock so Low / Medium / High cannot disagree with buffered ranges.
- Dedicated preview scheduler with priority and cancellation. Not the catalog/generation FIFO.
- Leases while a session is reading. Delayed GC.

Files: `src-tauri/src/library/timeline_fragments.rs` and a small coordinator/manifest next to it. Thin FE reconcile of the snapshot.

## Stage 4 — Proof

Required before calling this done. Not a reason to keep skip/fail-open alive (those die in stage 1).

Test inventory is the failure map: each F-number in [REQUIREMENTS-preview-failure-map.md](./REQUIREMENTS-preview-failure-map.md) gets a test or an accepted-risk note.

- jsdom: no skip, no fail-open, stale discard, continuity hold, blocked vs baking, missing-asset not ready.
- Packaged macOS (WKWebView) and Windows (WebView2): `media://` / CSP, `updateend`, quota, SourceBuffer error, `sourceopen` hang, reset/reload, remount during bake, seek, edit during play, quality/aspect switch, missing asset arrival, long play across every 2s boundary.
- Soak: for every clock sample in video content, the active generation’s exact segment is verified and a frame was presented. Zero silent skips, stale frames, or live-decoder fallbacks.

## Done when

- Play and seek cannot present unverified video time.
- Current and next (when there is a next) are verified before the picture rolls.
- In-window baked fragments load until verified or the user leaves the window. Failures retry on a timer or stop as blocked with Retry.
- Stale generation cannot append. Rendition change rebuilds MSE.
- Missing media is dependency-waiting (last frame + badge + auto-resume), never black-ready. Empty picture slots may be black.
- Remount sees valid disk work. Prune cannot delete in-flight reads.
- Status never says ready for disk-only fragments.
- Packaged fault and soak suites pass on macOS and Windows.

## Not this plan

- Per-fragment SHA-256, unless we later see real corruption.
- Preview work on the existing `jobs.rs` FIFO.
- Shared CMAF init redesign, unless measurements demand it.
- Loading every background bake into MSE.
- Publisher/export. Replacing the baked audio mix.
- Pretending uninterrupted playback survives unrecoverable machine failure.

## History

- Cursor draft: first incision (tickets, hold, dual bake). Too small to stop thinking about.
- Codex draft: correct ceiling (revision, manifest, range_verified). Too large, and it left skip/fail-open until phase 3.
- Codex final recommendation: converged with this plan; its deltas (missing-media hold-last-frame, bounded recovery loop, Windows coverage) are merged above.
- This file takes Cursor sequencing and Codex invariants. Stages 1–4 are all required.
