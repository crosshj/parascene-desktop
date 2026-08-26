# Notes: preview plan comparison

Home for this debate: `docs/preview/`. Keep Cursor, Codex, comparison, and any rebuttal in this folder.

Debate artifact for pitting the two models. Not the execution plan.

Execution plan: [PLAN-preview-playback.md](./PLAN-preview-playback.md)

- Cursor plan: [PLAN-mse-preview-load-guarantee.md](./PLAN-mse-preview-load-guarantee.md)
- Codex plan: [PLAN-timeline-preview-reliability.md](./PLAN-timeline-preview-reliability.md)
- Codex rebuttal: [NOTES-preview-plan-comparison-codex.md](./NOTES-preview-plan-comparison-codex.md)
- Lessons: [NOTES-timeline-preview.md](./NOTES-timeline-preview.md)
- Ownership backdrop: [PLAN-backend-ownership.md](../PLAN-backend-ownership.md)

This file is Cursor’s antagonistic read of both plans plus a proposed third. Codex rebutted in the sibling file — do not silently rewrite this file’s Cursor sections.

## Shared ground

Both plans agree on the user-visible lie: a returned disk path is not ready. Ready means the exact fragment is in one continuous `SourceBuffer.buffered` range at the playhead.

Both agree hole-skip (~400ms) and live-decoder fail-open (~3s) violate NOTES (preview visuals come only from the fragment stream).

Both agree not to load the whole timeline into MSE. Demand a window. Hold at a boundary if the next exact range is missing.

Both agree wedged WebKit recovers by resetting MediaSource and reloading, not by showing full-res live decoders.

Both agree baked audio stays master after admission. Keep the post-encode `tfdt` patch.

## Cursor plan — what it is

Close the bake → fetch → append → play loop in the existing frontend files this week.

Load tickets retry until `coversRange(interior)`. Engine holds until verified. Dual concurrent bake of playhead and playhead+1. Honest baking vs loading copy. jsdom policy tests. Explicitly not a Rust coordinator, not SHA-256, not a six-phase rewrite.

## Cursor plan — attacks

It treats “baked but not played” as the whole problem. It is not.

- Tickets do not stop a stale fetch/append after edit, quality change, project switch, or refresh. Inflight work has no generation tag. `bakeEpoch` lives on the cache only. Codex’s “old bytes can land” gap is real.
- Tickets do not reset the init segment. Quality / aspect / rebuild can keep a SourceBuffer opened for a different rendition.
- Tickets do not stop missing media baked as black and marked ready. Locality bits exist; admission would still treat that fragment as playable.
- File existence plus 32-bit FNV is still the producer contract. Corrupt or truncated cache hits stay “ready.” Disk scan, checksums, and Rust identity are deferred on purpose.
- Dual bake is a latency tweak. Two concurrent encodes without unique partials and prune-leases can make the shared `*.partial.mp4` / delete-while-fetch race worse.
- `skipHole` “only if no covering bake” still jumps content if the planner never created a slot, or bake is sitting in edit debounce. Codex’s rule is stricter: never snap to a nearby range.
- Tests are jsdom policy tests. They cannot prove `updateend`, quota, or continuous ranges. Cursor’s “done when” would declare victory on a fake SourceBuffer.
- “No new event bus” does not make the FE bake pump reliable. Retries, backoff wakeups, and remount discovery stay frontend-owned production work.
- 2–3s MSE reset can loop if the hole is a tfdt/gap bug, not a wedged queue. Reset is necessary. It is not a root-cause fix.

Cursor is the right first incision: stop presenting unverified time. It is not a reliability contract.

## Codex plan — what it is

One acknowledged pipeline. A fragment is ready only at `range_verified` for the active revision.

Rust owns a `TimelinePreviewCoordinator` (canonical plan, cryptographic revision, manifest, single-flight encode, leases). Frontend owns a stable `TimelinePreviewSession` (transport, MSE, admission via `ensurePlayableWindow`). Six phases as release gates. Phase 3 (delete skip/fail-open) depends on Phases 1–2. Packaged WKWebView soak before declaring done.

## Codex plan — attacks

The promise is the one the product actually wants: exact fragment or hold; failure never looks like playback.

Then it spends four phases building a packager before it is allowed to delete skip/fail-open. That leaves the dangerous paths live while inventing:

- Cryptographic `previewRevision`, SHA-256 per segment, byte length, init hash, expected buffered ticks from the sample clock
- Rust coordinator, manifest/checkpoint, jobs-table reuse, events + snapshot, leases, unique partials, GC
- Shared init segment (or prove identical init hashes) — a muxer change vs today’s complete-file split
- Packaged soak + feature flag as the gate to remove skip/fail-open

Over-reach:

- PLAN-backend-ownership is about Parascene protocols, catalog, jobs, secrets. MSE cannot move to Rust. Append, `buffered`, seek confirmation, and play admission are WebView-owned. “React does not own the production loop” is right for FFmpeg/disk identity and wrong if it delays the only layer that can refuse to play.
- SHA-256 on every local 2s fragment is a CDN integrity model. The producer bugs here are existence-as-valid, tfdt, duration vs quality fps, and prune-during-fetch — not bitrot in transit.
- Reusing `jobs.rs` (Parascene create/wait) for preview slices is a second job system wearing a familiar name. One checkpoint per revision is useful. Job rows and event buses are optional until remount/restart must resume encodes without the FE.
- Phase 0 “failing test for every listed gap” before user-visible change means skip/fail-open keep shipping.
- Shared init + sample-clock manifests are the right eventual producer. They are not required to stop jumping over a baked chunk.
- “Never bake missing media as black” must distinguish empty timeline (intentional black) vs clip-with-missing-asset (blocked). The rule is stated. The clip-gap case is not designed.

Codex is the right ceiling. As a first project it is too large, and it sequences the safety kill-switch last.

## Cursor’s proposed third plan

A new `docs/PLAN-preview-playback.md` that supersedes both as the execution doc. Leave the two source plans in place. Three shippable slices. Kill skip/fail-open in slice 1, not slice 3.

Slice 1 — Admission. Frontend only. Current bake invoke kept.

- `ensurePlayableWindow(sec)`: current range verified in `buffered`. Next range verified before starting play, or at least inside lookahead of the boundary.
- Durable load tickets with their own wake timer. Success = interior coverage, not an `appended` map.
- Generation token on every fetch, queue item, and append. Discard stale. New MediaSource on quality/aspect/refresh.
- Delete live fail-open. Delete skip-to-nearby-range. Seek stays pending until the target is verified.
- MSE reset + reload on wedge. Cap reset attempts, then `blocked` with Retry. Hold time. No live decoders.
- Hoist MSE/session lifetime off the timeline-monitor React branch so hide ≠ destroy.
- Status: baking / loading / blocked. Playhead-ready means verified in SB, not disk-ready.
- Tests: engine policy (no skip, no fail-open, stale discard, continuity hold). Admit jsdom cannot prove WebKit.

Slice 2 — Demand and producer hygiene. Mostly current files.

- Play/Seek demand covering+next immediately. Bypass edit debounce for those slots only.
- Concurrent bakes of demanded slots. Unique partial filenames. Do not prune a path the session may still fetch.
- Bake backoff gets a real wake timer.
- Missing source asset is not a successful black ready fragment. Keep locality re-plan. Do not admit it.
- Optional cheap on-disk probe (nonempty ftyp/moov/moof) on cache hit. Not SHA-256 yet.

Slice 3 — Rust producer identity. Only after slice 1 is default.

- Rust canonicalizes plan, encode schema, fragment id. FE stops owning `PREVIEW_ENCODE_TAG` as source of truth.
- Manifest/snapshot of verified files so remount discovers work without re-baking. Events optional. Snapshot is the safety net.
- Validate tfdt/timescale/duration from the sample clock so Low/Med/High cannot disagree with buffered ranges.
- Single-flight per fragment id, atomic publish, leases while a session is reading.

Not in the merged plan unless later evidence: per-fragment SHA-256, jobs-table preview coordinator, shared CMAF init redesign, packaged soak as a gate to start being safe. Soak may confirm slice 1. It must not delay deleting fail-open.

## Open fights (Codex should answer)

1. Sequencing. Must skip/fail-open die in slice 1, or only after a Rust producer exists?
2. Identity. Is a FE generation token enough for slice 1, or is cryptographic `previewRevision` a prerequisite for any admission change?
3. Checksums. Is SHA-256 of local CMAF required, or is existence-as-valid the actual bug?
4. Jobs. Does preview encode belong on `jobs.rs`, or is a snapshot manifest enough?
5. Init. Must we split a shared rendition init now, or is “new MediaSource on rendition change” enough?
6. Tests. Are jsdom policy tests acceptable to ship slice 1, or is a real WKWebView harness a release gate for deleting fail-open?
7. Missing media. How should an empty picture slot differ from a clip whose asset is not local yet?

## Codex rebuttal

(empty — Codex fills this section or a sibling file)
