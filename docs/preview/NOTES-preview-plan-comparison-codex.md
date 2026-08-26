# Notes: preview plan comparison — Codex rebuttal

Debate artifact. This is an adversarial review of the two proposed plans, not an execution plan.

- Cursor/Grok: [PLAN-mse-preview-load-guarantee.md](./PLAN-mse-preview-load-guarantee.md)
- Codex: [PLAN-timeline-preview-reliability.md](./PLAN-timeline-preview-reliability.md)
- Cursor comparison: [NOTES-preview-plan-comparison.md](./NOTES-preview-plan-comparison.md)
- Execution plan: [PLAN-preview-playback.md](./PLAN-preview-playback.md)

## Blunt verdict

Cursor’s plan is a useful hotfix wearing a “guarantee” label. Codex’s plan is the only one aimed at a real reliability contract, but it is an architecture program masquerading as a near-term fix. Neither should ship unchanged.

Cursor is better at stopping the most visible lie quickly. Codex is better at preventing stale, corrupt, mis-versioned, or resurrected work from being called playable. The merged answer must take Cursor’s sequencing and Codex’s invariants.

## What both plans get right

- A returned path is not readiness. The exact bytes must be fetched, appended, and verified in the active `SourceBuffer`.
- A missing range must hold or report failure; nearby-range skipping and live-decoder fail-open contradict the product contract.
- MSE needs a bounded window, explicit reset/reload, and honest baking/loading/blocked status.
- Baked audio remains the clock, and the existing `tfdt` correction must not regress.

Both plans still underspecify “played.” `SourceBuffer.buffered` proves neither decode nor frame presentation. A real contract also needs `play()` rejection handling, `video.error`, `waiting`/`stalled`, and a frame-presented acknowledgement (for example, `requestVideoFrameCallback`).

## Cursor/Grok: the case against it

The plan is concrete and shippable, but its guarantee is conditional in every place that matters:

- “Skip only if no covering bake” still permits a skip when the planner never created a slot, edit debounce hid the slot, or the producer failed. Absence is not permission to jump.
- A ticket can retry fetching forever while the frontend bake pump is stopped. The current backoff has no reliable wake timer, so “retry” does not imply “eventually produced.”
- Index plus 32-bit FNV is not identity. It excludes source bytes and can admit stale work after edits, quality changes, refreshes, or late callbacks. A generation token is required even for the tactical slice.
- `coversRange(interior)` is too weak if it accepts a late-starting or merely adjacent range. It must prove exact start/end coverage and continuity for the demanded interval.
- `invoke` returning a path is not producer integrity. Missing assets are currently allowed to render black; Rust accepts any existing file; shared partial names and pruning can race a fetch. A successfully loaded wrong file is still failure.
- “Two concurrent bakes” is not a toggle. It changes the single FIFO pump, contention, pruning, and failure semantics before single-flight ownership exists.
- jsdom tests can validate policy but cannot validate WebKit `updateend`, quota, SourceBuffer errors, `sourceopen` hangs, or decoded frames. Calling that done would be test theater.
- The plan has no terminal blocked state, no hung-fetch deadline, and no explicit unsupported-MSE behavior. A reset loop is not recovery.

Cursor’s proposal is the right first incision: stop presenting unverified time. It is not yet a reliability contract.

## Codex: the case against our own plan

Codex correctly names the distributed-systems problem, then overreacts:

- The phase order leaves skip/fail-open live until Phase 3. That is backwards. The kill-switch must land first, before manifests, leases, jobs, or cryptographic identity.
- One `range_verified` state conflates three different machines: durable producer artifacts, session-local MSE contents, and the current playback window. Split them or remounts, eviction, and resets will produce false readiness.
- A whole-timeline `previewRevision` rebuild can invalidate unrelated ranges for a tiny edit. Use separate session generation, rendition identity, and segment content identity.
- A generic `jobs.rs` coordinator risks putting interactive preview behind existing FIFO sync/generation work. Preview needs priority/cancellation or a dedicated coordinator; familiar plumbing is not safe plumbing.
- SHA-256 for every two-second local fragment is expensive and not the first bug to solve. Validate complete MP4 structure, timing, codec, and publication atomicity first; hash published artifacts once if later evidence requires it.
- Shared init redesign, leases, GC, event bus, and a packaged soak harness are valuable release work, but the plan does not specify schemas, fsync ordering, APIs, or migration boundaries tightly enough to implement.
- “Played” is still underdefined in our plan too. Add explicit decode/frame evidence and bounded waits.

Codex is the correct reliability ceiling, but not a ticket-ready first milestone.

## The merged position

1. **Safety first:** remove skip and fail-open immediately; keep the playhead pending until the exact current range and next runway are verified. Hoist the MSE session off the React branch that currently destroys it on unmount.
2. **Admission protocol:** add generation/rendition/segment IDs, abortable fetches with deadlines, stale-append rejection, exact contiguous-range checks, bounded reset attempts, and `baking`/`loading`/`blocked` per-slot status. Add a real backoff wake timer.
3. **Producer correctness:** unique partials, single-flight per segment, atomic publication, no prune while leased, full structural/timing validation, and explicit distinction between intentional empty black and a missing asset dependency.
4. **Durable ownership:** add a compact manifest/snapshot and restart reconciliation. Introduce a backend coordinator only when its priority and cancellation semantics are specified; do not hide preview behind the existing FIFO worker.
5. **Proof:** use jsdom for policy regressions, but require packaged WKWebView fault/soak tests before claiming “guaranteed.” Include frame presentation, quota errors, sourceopen hangs, refresh/remount, and missing-media cases.

## Answers to the open fights

- **Sequencing:** kill skip/fail-open in slice 1, not after Rust infrastructure.
- **Identity:** a frontend generation token is enough for slice 1; cryptographic artifact identity belongs in producer hardening.
- **Checksums:** no SHA-256 prerequisite. Existence-only validation must disappear immediately; structural/timing validation comes first.
- **Jobs:** do not reuse the general FIFO worker without priority/cancellation. A manifest plus dedicated preview scheduling is safer.
- **Init:** create a new MediaSource when rendition/config changes; defer a shared-init redesign until measurements demand it.
- **Tests:** jsdom is acceptable for policy changes, never as evidence of WebKit playback reliability.
- **Missing media:** intentional empty span may be black; a clip whose source is unavailable is blocked/dependency-waiting and is never admitted as ready.

## Bottom line

If the deadline is days, ship Cursor’s admission hardening and call it that. If the requirement is literal reliability, use Codex’s contract, cut it into the five stages above, and refuse to declare success until the real WebKit failure modes are exercised. The two original plans are complements—not alternatives—and each becomes dangerous when treated as complete.
