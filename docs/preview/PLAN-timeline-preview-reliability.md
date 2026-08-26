# Plan: Reliable timeline preview

Make timeline preview delivery one acknowledged pipeline. A fragment is not ready when FFmpeg returns a path. It is ready only when the exact active revision is verified on disk, fetched and verified in the WebView, appended, and present in one continuous `SourceBuffer.buffered` range.

Status: historical draft. Execution is [PLAN-preview-playback.md](./PLAN-preview-playback.md).

This is the Codex draft. Superseded for execution by [PLAN-preview-playback.md](./PLAN-preview-playback.md). Related: [NOTES-timeline-preview.md](./NOTES-timeline-preview.md), [PLAN-backend-ownership.md](../PLAN-backend-ownership.md), [GUIDE-architecture-principles.md](../GUIDE-architecture-principles.md). Debate: [NOTES-preview-plan-comparison.md](./NOTES-preview-plan-comparison.md).

## Reliability promise

- At every video timestamp, show the exact fragment for the active timeline revision or hold on that timestamp.
- Never advance over a missing range, jump to a later range, bake missing source media as valid black, or silently switch to live decoders.
- Keep retrying recoverable work on scheduled timers. Do not depend on another render, playhead move, or remount to wake it.
- If FFmpeg, disk, transport, or WebKit cannot recover, stop with a precise error and a scoped Retry action.
- Treat MSE support, usable FFmpeg, readable source media, and writable cache space as explicit prerequisites.

No design can promise that FFmpeg, disk, or WebKit never fails. The enforceable guarantee is that failure never masquerades as correct playback: requested content either plays exactly or playback visibly stops.

## Current gaps

- `timelineFragmentCache.ts` calls a returned disk path ready. Fetch, append, buffered coverage, and playback are separate best-effort steps.
- `timelinePlaybackEngine.ts` can skip a short hole after 400 ms and disable MSE after 3 seconds. This conflicts with the fragment-only rule in `NOTES-timeline-preview.md`.
- Play starts with about 20 ms of coverage. The existing continuity and window-ready checks are not used by playback.
- `mseFragmentPlayer.ts` has no plan-generation guard. An old fetch or queued append can land after an edit, project switch, refresh, or quality change.
- The MSE init segment is appended once for the player lifetime. A new aspect, resolution, frame rate, codec config, or rebuild does not force a clean rendition session.
- A missing source can be omitted and the resulting black fragment can become ready. There is no authoritative media-ready subscription to heal it later.
- Cached files are accepted by existence. The 32-bit frontend fingerprint does not cover source bytes, and neither side validates full codec/timestamp/duration integrity on a cache hit.
- Bake retry backoff has no guaranteed wake-up. Fetch and append failures are often dropped or retried only if another feed happens.
- Refresh, clear, prune, and uncancelled bakes can race. Concurrent callers share a partial filename, and old files can be removed while the WebView fetches them.
- The MSE host is tied to the conditional timeline-monitor React branch. Leaving that branch destroys loaded buffers even though background baking continues.
- Current browser tests do not exercise real `MediaSource` or `SourceBuffer` success, error, quota, close, or hang behavior.

## Required contract

Use one immutable `previewRevision` for the canonical timeline, source identities, aspect, quality, and backend encode schema.

Every segment carries:

- Revision, rendition, index, exact start/end ticks, and immutable segment id.
- SHA-256, byte length, codec/profile/level, dimensions, frame rate, timescale, and init hash.
- Expected buffered start/end derived from encoded samples, not requested wall-clock duration.
- State, attempt count, next retry time, and a structured stage-specific error.

The lifecycle is explicit:

- `planned`
- `dependency_wait`, `queued`, or `encoding`
- `file_verified`
- `transfer_inflight` then `bytes_verified`
- `append_queued` then `appending`
- `range_verified`
- `consumed` or `blocked`

Only `range_verified` is frontend-ready. It requires the active revision and init hash, successful `updateend`, expected range coverage, and continuity through the playback safety horizon.

Intentional empty timeline spans may render black. Missing or unreadable media is `dependency_wait` or `blocked`, never a successful black substitute.

## Target ownership

Rust owns a `TimelinePreviewCoordinator`:

- Canonicalize the render plan and compute cryptographic revision and segment identities.
- Reconcile source availability and wake affected segments from library/media-ready events.
- Prioritize the demanded playhead window, then finish the remaining timeline in the background.
- Persist one manifest/checkpoint per revision. Use backend events for speed and a snapshot query as the missed-event safety net.
- Reuse the existing durable jobs/checkpoint model at revision level, not one job row per fragment and not a frontend-owned retry loop.
- Single-flight each segment id. Use unique partials, cancellation tokens, atomic publish, and delayed garbage collection.
- Keep immutable artifacts leased while any preview session may read them. Never clear or prune a live generation.

The frontend owns one stable `TimelinePreviewSession` for the editor/project lifetime:

- Reconcile the backend manifest; do not infer production state from promise completion.
- Own transport, verified bytes, the MSE operation queue, actual buffered ranges, and playback admission.
- Stay mounted while source/timeline monitor UI switches. Show or hide the video element without destroying the session.
- Tag every fetch, queue item, callback, and retry with revision and rendition. Abort or discard stale work before enqueue and again before append.
- Expose one `ensurePlayableWindow(sec, aheadSec)` result to the playback engine.

React sends timeline, playhead, and transport intent and renders session status. It does not own the long-running production loop.

## Producer and artifact rules

- Put the encode schema version beside the Rust encoder parameters. Do not maintain an unrelated frontend cache tag.
- Include canonical clip inputs and immutable source identity in the digest. Same-path rewrites must produce a new identity.
- Block on expected source media. Continue producing unrelated segments while dependencies arrive.
- On both new output and cache hit, validate nonempty `ftyp/moov/moof/mdat`, video-only track shape, codec config, closed GOP/keyframe, timescale, exact `tfdt`, sample count, duration, dimensions, and init compatibility.
- Produce one shared init segment per rendition, or prove every segment has the same init hash. A different init hash always starts a new MSE session.
- Write a unique temporary file, flush it, rename atomically, then atomically publish the manifest entry.
- Quarantine and rebuild corrupt or mismatched cache hits. File existence is never sufficient.
- Derive tail duration from the encoded sample clock so Low, Medium, and High cannot disagree with the manifest.

## Load and playback protocol

- Timeline activation, Play, and Seek immediately demand the target segment plus a forward safety horizon; they bypass edit debounce.
- Fetch the target first, then forward in timeline order. Bound concurrency; fetch completion order must not decide append order.
- Fetch through one audited local protocol using opaque segment identity. Require success status, timeout, expected byte length, SHA-256, and validated fMP4 structure.
- Append the verified rendition init once, then serialize media appends. Retain the current operation until success or classified failure.
- After `updateend`, verify the expected segment range and continuous horizon in `SourceBuffer.buffered`. Do not mark success from bookkeeping alone.
- Start or resume picture and audio only after `ensurePlayableWindow` resolves. Require at least the current and next segment, or all remaining picture when shorter.
- Maintain low and high watermarks based on segment duration. Produce and load ahead before reaching the low watermark.
- If the next exact range is not ready, pause picture, audio, and the authoritative playhead before the boundary. Resume atomically after range verification.
- A seek remains pending until the target range is verified and the video element confirms the seek/frame. It never snaps to a nearby buffered time.
- On an edit or rendition change, freeze playback, retire the old revision, rebuild MSE, and resume only on verified new coverage.
- Keep baked audio as the running master clock after admission; correct video drift as recorded in `NOTES-timeline-preview.md`.
- The audio-only tail needs no video fragment, but the transition into it must be explicit in the manifest.

## Recovery

- Schedule retries with timeout, bounded exponential backoff, jitter, and a real wake timer. Key retry state by revision and segment id.
- A missing, truncated, or hash-mismatched artifact invalidates only that segment and requests a backend rebuild.
- A transport failure retries the immutable segment URL and reconciles the manifest before deciding the file is gone.
- An init, append, `SourceBuffer`, `MediaSource`, quota, or watchdog failure rebuilds the MSE session and replays the verified target window.
- Evict only acknowledged ranges outside the protected window. Never remove data under or immediately ahead of a playing head.
- Keep per-segment errors until that segment recovers. An unrelated success must not clear them.
- After the recovery budget is exhausted, enter `blocked`, hold time, name the failed stage and segment, and offer scoped Retry/Rebuild.
- Keep whole-cache rebuild as a diagnostic action, not routine recovery.

## Phases

- Phase 0 — Contract and failing tests. No dependency.
  Add revision-aware tracing, deterministic clocks, fault hooks, and tests that reproduce missed completion, stale fetch, retry sleep, init reuse, hole skip, and missing-source black. Exit when each current gap has a failing test and the safety promise is executable as assertions.
- Phase 1 — Durable producer. Depends on Phase 0.
  Add the Rust coordinator, canonical digest, source dependency states, manifest snapshot/events, single-flight encoding, artifact validation, unique partials, and leases. Exit when remount/restart discovers valid work and corrupt work is rebuilt without frontend orchestration.
- Phase 2 — Acknowledged frontend session. Depends on Phase 1.
  Hoist session lifetime, add generation-safe fetch/append queues, byte verification, shared init handling, range acknowledgement, scheduled retry, and MSE reconstruction. Exit when stale generations cannot append and every requested segment reaches `range_verified` or `blocked`.
- Phase 3 — Playback admission. Depends on Phase 2.
  Route Play/Seek through `ensurePlayableWindow`, enforce watermarks and boundary holds, and remove automatic hole skipping and silent decoder fallback. Exit when the clock cannot enter an unverified video range.
- Phase 4 — Lifecycle and recovery. Depends on Phases 1–3.
  Cover edit/project/aspect/quality changes, asset arrival, refresh, remount, sleep/wake, quota pressure, cache GC, and terminal errors. Exit when all transitions recover or stop explicitly without stale pixels.
- Phase 5 — Packaged validation and rollout. Depends on all prior phases.
  Run real FFmpeg plus packaged WKWebView tests, long seek/edit/play soaks, and fault injection behind a temporary feature flag. Make the path default only after every acceptance gate passes; remove the legacy skip/fail-open path before declaring validation.

## Verification gates

- Rust tests: canonical digest, source change, concurrent ensure, cancellation, crash partial, corrupt cache hit, timestamp/duration validation, clear-versus-bake, leases, and restart reconciliation.
- Frontend state-machine tests: missed event plus poll recovery, stale completion ordering, scheduled retry, rendition reset, deterministic priority, and segment-scoped errors.
- MSE harness tests: init append, media `updateend`, wrong range, async error, synchronous exception, quota, source close, hang watchdog, rebuild, and exact-generation coverage.
- Packaged macOS tests: `media://` and CSP, first launch, remount during bake, rapid seeks, edit during playback, project/aspect/quality switch, missing asset arrival, sleep/wake, and long playback across every boundary.
- Fault tests: missing file, 404, truncated bytes, checksum mismatch, invalid boxes, FFmpeg failure, disk full, permission error, slow transport, and insufficient MSE quota.
- Soak assertion: for every clock sample in video content, the active revision's exact segment is `range_verified`; zero silent skips, stale frames, or renderer fallbacks.

Use real WebKit/MSE coverage for release decisions. The current jsdom-only media tests are useful unit checks but cannot validate buffering behavior.

## Done when

- Every Play and Seek has a traceable revision, demand window, and terminal result.
- Backend `file_verified` survives remount/restart and is never inferred from file existence alone.
- Frontend status distinguishes produced, fetched, appended, and range-verified fragments.
- Playback never advances into an absent, stale, wrong-rendition, or unverified range.
- Missing media never becomes an authoritative black fragment and heals automatically when it arrives.
- Fetch, append, quota, and MediaSource failures self-heal in tests or stop with an actionable error.
- Project, timeline, quality, aspect, refresh, and lifecycle changes cannot accept late work from an old revision.
- Continuous buffered ranges are proven across every fragment boundary and quality preset.
- Packaged WKWebView fault and soak suites pass with no hole skip or automatic live-decoder fallback.

## Not this plan

- Publisher/export changes.
- Replacing the baked audio mix or its audio-master clock.
- Loading the full timeline into MSE before every play; the guarantee comes from verified demand windows and boundary holds.
- Pretending uninterrupted playback is possible after an unrecoverable machine failure. Correct pause and explicit failure are part of the contract.
