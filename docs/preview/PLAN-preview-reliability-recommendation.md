# Recommendation: reliable timeline preview

Status: merged into [PLAN-preview-playback.md](./PLAN-preview-playback.md), the canonical execution plan. Kept as history.

## Decision

Adopt a durable hybrid of the two proposals. Use Cursor/Grok’s immediate frontend admission hardening, then add Codex’s producer ownership, identity, persistence, and packaged-platform verification. Neither original plan is sufficient by itself.

The product contract is not “never stall.” It is “never silently do the wrong thing, never lock, and recover without requiring the user to understand MSE.”

## User-visible contract

- The preview plays the exact requested timeline range when it is available.
- A short hiccup triggers automatic retry, MSE reset, and reload. The UI remains responsive.
- The player never skips over an unready range and never silently falls back to a different live decoder.
- If recovery cannot complete, playback pauses cleanly and shows a retryable, non-blocking status.
- Intentional empty timeline spans render black.
- A clip whose source is missing or unreadable is a dependency-waiting state: hold the last presented frame, show a subtle warning badge, and resume automatically when the source becomes available.

## Required architecture

### 1. Frontend admission and session safety

- Keep a stable preview session independent of the React monitor branch; hiding or remounting UI must not destroy MSE state.
- Give every session, rendition, and segment a generation-aware identity. Reject stale fetch completions, queue entries, and appends.
- Admit playback only after exact contiguous coverage exists in the active `SourceBuffer` for the playhead and a small forward runway.
- Remove hole-skipping and fail-open behavior. A missing range waits, retries, or becomes visibly blocked.
- Add abortable fetches, deadlines, bounded reset attempts, and a terminal retry state so failures cannot loop forever.
- Track per-segment `baking`, `loading`, `verified`, and `blocked` status. Disk readiness is never playback readiness.

### 2. Producer correctness

- Use unique partial output paths, single-flight encoding per segment identity, atomic publication, and pruning protection while a session may read an artifact.
- Validate complete artifacts on cache hit: container structure, media presence, codec/configuration, duration, and `tfdt`/timescale alignment.
- Replace existence-only and weak fingerprint admission with explicit segment content identity. Add artifact hashes later if measurements justify the cost.
- Give the bake scheduler a real wake timer after backoff and explicit dependency states for unavailable media.
- Distinguish intentional empty spans (valid black) from missing clip sources (not ready).

### 3. Durable ownership and recovery

- Persist a compact manifest/snapshot describing the active preview revision, segment identities, producer state, and validated artifacts.
- Reconcile that snapshot on remount and application restart; do not rely on a live React process to rediscover work.
- Add a backend coordinator only with priority and cancellation semantics that protect interactive preview from the existing FIFO job workload.
- Keep MSE operations in the frontend/WebView. Rust owns durable planning, encoding, publication, and artifact identity—not `SourceBuffer` or frame presentation.

## Recovery behavior

The recovery loop is bounded and observable:

1. Detect missing coverage, append error, quota error, fetch timeout, or stalled playback.
2. Stop admission at the affected boundary and preserve the last presented frame.
3. Abort stale work, reset the affected MSE session, and reload the exact demand window.
4. Retry with backoff and a visible status badge.
5. After the retry budget is exhausted, remain responsive in a retryable `blocked` state; never jump or deadlock.

“Played” must include more than `SourceBuffer.buffered`: handle `play()` rejection, `video.error`, `waiting`/`stalled`, and frame presentation acknowledgement.

## Delivery order

1. **Safety slice:** stable session, generation fences, exact admission, no skip/fail-open, deadlines, reset/reload, per-slot status, and backoff wakeups.
2. **Producer slice:** single-flight encoding, unique partials, atomic publication, artifact validation, dependency-waiting for missing media, and safe pruning.
3. **Durability slice:** manifest/snapshot, restart reconciliation, backend scheduling ownership, and garbage-collection leases where needed.
4. **Proof slice:** Windows and macOS packaged tests covering remounts, refreshes, edits, missing media, fetch hangs, `sourceopen` hangs, `updateend`/quota failures, resets, and frame presentation.

Do not delay the safety slice until the backend redesign is complete. Do not declare the system permanent until the durability and packaged-platform slices pass.

## Explicit non-goals

- No SHA-256 prerequisite for the first safety release.
- No generic preview work hidden behind the existing FIFO jobs worker without priority/cancellation.
- No shared-init/muxer redesign unless configuration changes prove it necessary.
- No jsdom-only claim of MSE reliability; jsdom tests are policy tests, not platform proof.

## Recommendation summary

Approve the hybrid architecture and sequence above. The success criterion is a preview that either plays the correct content or gracefully holds, explains, retries, and recovers—without silent skips, permanent locks, or user-managed MSE failures.
