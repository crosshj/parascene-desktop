# Plan: app performance regression and ref2video stability

Status: hardening pass implemented (Phase 1 + Phase 2 concurrency/parse). Low-ROI Phase 3 items skipped unless a later measurement says otherwise.

## Problem statement

The app has recently begun to feel persistently slow, as though background work is continuing when it is not needed. A user also reported `Maximum call stack size exceeded` at `String.match` while generating with ref2video.

The audit found two P0 defects:

- A recursive generation-reconciliation path directly explains the `String.match` stack overflow.
- The project asset catalog can enter a continuous React render → Tauri/SQLite fetch → state update loop.

Several additional schedulers and render-time operations amplify CPU, disk, memory, network, and database pressure. The changes most relevant to the regression are concentrated in the ref2video/job work from 1.1.50, the reconciliation and asset-preview changes from 1.1.51, and the timeline-preview work from 1.1.45–1.1.47.

## Goals

- Eliminate the ref2video stack overflow and make stale generation recovery finite and deterministic.
- Stop unnecessary catalog queries, React renders, listeners, frame extraction, and project parsing.
- Bound generation and preview concurrency so background work cannot monopolize the app.
- Make obsolete native and FFmpeg work cancellable where practical.
- Add regression tests and diagnostics that expose repeated work before it reaches users.
- Preserve correct generation resume behavior and responsive timeline preview.

## Non-goals

- Redesigning the entire generation or preview architecture in one release.
- Changing provider behavior unrelated to scheduling, reference preparation, or recovery.
- Treating `String.match` itself as the defect; it is only where the recursive call chain exhausts the stack.
- First pass: demand-window bake rewrite, event-driven jobs-worker rewrite, FFmpeg process kill, unified catalog store, or draft-persistence architecture beyond the existing debounce.

## ROI

Do not treat the findings as one flat “do first” list. The crash and idle loops are small and already explain the bug report. Several later items are high impact but higher effort, product risk, or only visible after those loops are gone.

### Immediate

These are the release candidates. Relatively contained. They address the stack overflow and the strongest persistent UI/SQLite tax.

- Stop recursive stale-job reconciliation.
- Fix the asset-catalog render/fetch loop, including stable picker arrays and race-safe listener `off()`.
- Skip notify/reconcile when `setClips` produces an identical plan. Cheap preview win; not the same as rewriting bake policy.
- Fingerprint and dedupe ref2video frame peeks so prompt edits do not launch media/FFmpeg work. Ignore stale results; do not add process kill in this pass.
- Keep temporary loop counters (catalog loads, reconciliation, listeners, active FFmpeg/generation). Those verify the fixes. They are not packaged benchmarks.

### Next, after the loops are gone

High value, not P0. Do these once idle churn is actually dead.

- Cap concurrent generation jobs with one semaphore so backlog and restart recovery cannot spawn everything at once. Acquire a permit before claiming, marking running, or spawning a job; jobs beyond the cap must remain queued rather than becoming unbounded tasks waiting on permits. Do not split network vs FFmpeg vs upload limits in this pass.
- Move stored-project parsing out of Editor render. Use the already-normalized project. Real main-thread cost during playback (~5 Hz); not an architecture rewrite.
- Limit preview baking to a playhead-centered demand window only if FFmpeg is still encoding the whole timeline while idle. High impact on long timelines, higher product risk (exact coverage, no silent skip). Playhead priority already exists; the pump still drains every dirty fragment.

Do not rewrite the jobs worker to event-driven wakeup as part of the cap. The 200 ms empty-queue poll only runs while parallel jobs are in flight. A longer sleep when the queue is empty is enough if polling still shows up.

### Defer until measurement says otherwise

Real improvements. Weak against idle slowness and the stack overflow. Follow the crash, continuous-work, and concurrency fixes unless a specific workload is dominated by one of these.

- Further draft-persistence work beyond the existing 400 ms debounce.
- Consolidate duplicate job watchers into one ownership path.
- Compact MP4 artifact-validation metadata so cache hits do not reread whole files.
- Stream Blue uploads instead of reading files into memory.
- Split provider/network concurrency from local FFmpeg and large-file upload limits. One generation cap is the 80%; extra semaphores only if a single limit is clearly wrong.
- Cache prepared reference PNGs and batch `getCreations` lookups.
- Event-driven jobs-worker rewrite.
- Kill/abort obsolete FFmpeg bakes and in-flight frame peeks. Ignore-stale is already there; stop starting superseded work first.
- Unified project-scoped catalog store. Memoized context plus unchanged-data guards should kill the loop.
- Packaged macOS/Windows performance proof. Needed for confidence; does not make the app faster.

Low ROI does not mean unnecessary.

## Findings and required work

### P0: stale generation reconciliation recurses forever

Location: `src/layouts/editor/addAssetGenerationStore.ts`, around `reconcileAddAssetGenerations` lines 950–970.

For a persisted generation job with `status === "starting"` and no Replicate prediction ID, pending creation ID, Blue job ID, or service job ID, reconciliation currently:

1. Adds the clip to `resumeAttempted`.
2. Calls `applyJobFailure`.
3. Deletes the clip from `resumeAttempted`.
4. Recursively calls `reconcileAddAssetGenerations(opts)`.

The recursive call receives the same stale `opts.timeline`. Updating application state through `applyJobFailure` does not mutate that input timeline. Because the guard is removed before recursion, the same clip is selected again indefinitely.

`applyJobFailure` calls `creationIdFromWaitTimeoutError(message)` in `src/layouts/editor/addAssetGenerationResume.ts`, which executes `String(message ?? "").match(...)`. That explains why the reported stack trace ends at `String.match`: the regex call is repeated once per recursive pass until the JavaScript stack is exhausted.

The vulnerable marker is persisted before a remote job exists in `startAddAssetGenerationJob`. Resolving and uploading multiple ref2video inputs lengthens this interval. A reload, HMR replacement, crash, or watcher failure can therefore leave a stale `starting` marker.

The recursive defect predates 1.1.50, but recent work made it easier to reach:

- 1.1.50 expanded generation providers, remote identifiers, ref2video flows, and resume behavior.
- 1.1.51 added reconciliation on terminal backend job events and a 15-second zombie sweep in `src/app/ShellProvider.tsx`.

Required changes:

- Replace recursive candidate processing with a finite iterative pass, or stop after marking the stale job failed.
- Do not retry a candidate until reconciliation receives a refreshed timeline that reflects the failure.
- Keep the per-clip reconciliation guard for the complete reconciliation attempt.
- Ensure one malformed candidate cannot prevent valid remote jobs later in the timeline from resuming.
- Make repeated calls idempotent after a stale `starting` job is marked failed.

Required tests:

- A `starting` job without any remote ID is marked failed once and reconciliation returns without recursion.
- Multiple stale candidates are each processed at most once.
- A stale candidate followed by a resumable remote job does not block the remote job.
- Repeated Shell reconciliation events and interval sweeps remain no-ops after the failure is applied.
- Reload/HMR-style loss of in-memory guards does not overflow or duplicate work.

Done when: the reported state cannot recurse, stack depth remains constant regardless of candidate count, and stale recovery remains deterministic under repeated triggers.

### P0: project asset catalog forms a self-sustaining fetch loop

Locations:

- `src/layouts/editor/EditorLayout.tsx`, around lines 577–600.
- `src/layouts/editor/projectImagePickerAssets.ts`, around lines 116–173.
- `src/layouts/editor/AddAssetGeneratePanel.tsx`, around lines 1284–1301.

`EditorLayout` passes a new inline context object to `useProjectPickerAssets` on every render. The hook effect depends on that object by identity, loads project asset creations, then unconditionally stores a newly allocated result object.

The resulting loop is:

`render → new context identity → effect → library_get_creations → setState → render`

This loop can continue for as long as the project contains assets, even when no creation data changes. Each pass crosses Tauri IPC and reaches the SQLite-backed library catalog, so the cost is not limited to React rendering.

The returned picker asset array is also recreated because it depends on the unstable context. This recreates the image/video/audio arrays in `EditorLayout`. The generate panel then reacts to the new image/video array identities and fetches previews again. Version 1.1.51 widened that panel query to video assets, making this especially visible in ref2video.

The hook has a listener cleanup race as well. `listen(...).then(off => unlisten = off)` can resolve after effect cleanup has already observed `unlisten` as undefined. That listener is then never removed. A rapidly rerunning effect can accumulate `library-creation-updated` listeners and turn later library events into render storms.

Required changes:

- Memoize the context in `EditorLayout`, or change the hook API to accept stable primitive dependencies.
- Do not update `creationsById` when the material creation data is unchanged.
- Stabilize returned asset arrays when their contents have not changed.
- Make asynchronous listener disposal race-safe by immediately calling `off()` if the effect was already disposed.
- Avoid a second preview catalog fetch when the picker hook already has the required creation rows or preview URLs.
- Do not start a project-scoped catalog store in this pass. Memoized context plus unchanged-data guards should kill the loop; a unified store is deferred.

Required tests and instrumentation:

- Render the editor with non-empty assets and assert the catalog loader is called once for stable inputs.
- Re-render the parent with equivalent project values and assert no additional load occurs.
- Change one relevant project ID or asset ID and assert exactly one reload.
- Resolve listener registration after cleanup and assert the returned listener is removed.
- Add a development-only counter or trace for catalog loads per project so a tight loop is obvious.

Done when: an idle editor with unchanged assets performs no repeated catalog calls or state updates, and mounting/unmounting leaves no library listeners behind.

### P1: timeline preview eagerly encodes the entire dirty timeline

Locations:

- `src/layouts/editor/timelineFragmentCache.ts`, especially `nextJob`, `maybePump`, and `commitClips`.
- `src/layouts/editor/EditorLayout.tsx`, where `fragmentCache.setClips` runs.
- `src-tauri/src/library/timeline_fragments.rs`, fragment validation and baking.

`nextJob` considers every dirty fragment. `maybePump` immediately replaces each completed bake with another until all fragments are ready. As a result, opening an editor can sustain two FFmpeg encodes until the complete timeline is rendered, even if the user does not press play.

Timeline edits dirty fragments and start more work. Generation/fingerprint fencing prevents stale results from being admitted, but it does not terminate an obsolete FFmpeg process. Rapid edits can therefore leave outdated encodes competing with current work.

`commitClips` also recalculates the full plan, notifies subscribers, and starts snapshot reconciliation even when the material plan did not change. On cache hits, `fragment_artifact_matches_plan` reads the complete MP4 into memory and scans its bytes for container markers and timing data.

Immediate change:

- Skip notify/reconcile work when `setClips` produces an identical plan.

Follow-up changes — Phase 2 only if idle FFmpeg remains a measured cost:

- Restrict automatic preview baking to the playhead and a bounded forward/backward window.
- Run whole-timeline warming only during an explicit idle phase or user-requested rebuild.
- Give interactive playback fragments priority over background warming and generation work.
- Preserve existing preview reliability requirements—exact coverage and no silent skip.

Follow-up changes — Phase 3 only if measurement justifies them:

- Add cancellation or process termination for obsolete FFmpeg bakes where safe.
- Store compact validated artifact metadata so routine reconciliation does not reread every complete MP4.

Immediate test:

- Reapplying an identical timeline does not notify, reconcile, or rebake.

Follow-up tests and measurements, when demand-window work is selected:

- Opening a long timeline without playback schedules only the bounded demand window.
- Moving the playhead reprioritizes work and cancels or deprioritizes obsolete distant work.
- Measure FFmpeg process count, CPU time, disk reads, and time-to-interactive on representative long timelines.

Immediate work is done when an unchanged timeline performs no redundant notification or snapshot reconciliation. If demand-window scheduling is selected, that work is done when an idle editor cannot continuously encode an entire long timeline and interactive preview receives bounded, prioritized work without weakening exact-coverage behavior.

### P1: generation jobs have unbounded parallelism and poll SQLite while idle

Location: `src-tauri/src/library/jobs.rs`, especially `is_parallel_job_kind`, `recover_interrupted_jobs`, and `jobs_worker`.

Blue, Replicate, and Parascene generation jobs are marked parallel, but no concurrency limit is applied. The worker spawns every queued parallel generation. On restart, all `running` and `waiting` jobs are returned to `queued`, allowing the complete backlog to launch simultaneously.

While any parallel job remains in flight and no queued job is found, the worker sleeps 200 ms and calls `claim_next_job` again. `with_conn` resolves library paths and opens/prepares a SQLite connection, producing five empty queue checks per second for the duration of long video jobs.

Reference preparation further amplifies resource use:

- Blue prepares image references with separate FFmpeg invocations and unique timestamped PNGs rather than a reusable prepared-media cache.
- Blue video/audio multipart uploads read the complete file into a `Vec<u8>`.
- Multiple concurrent jobs multiply memory, disk, encoding, and network pressure.
- Parascene and local-reference resolution often perform serial `getCreations` calls per asset instead of one batched lookup.

Phase 2 required changes:

- Add one bounded semaphore for generation jobs, with a deliberately selected default limit.
- Acquire the permit before claiming the next generation job, changing its status to `running`, or spawning its task. Do not claim the complete backlog and then make spawned tasks wait for permits.
- Leave jobs beyond the available permits in `queued` so status, cancellation, restart recovery, and resource accounting remain truthful.
- Recover interrupted jobs into that same cap rather than spawning the complete backlog.

Phase 3 follow-up changes, only if measurement justifies them:

- Replace 200 ms empty-queue polling with a longer sleep or worker notification/channel plus a slow safety wakeup.
- Split provider/network concurrency from local FFmpeg and large-file upload concurrency only if a single limit is clearly wrong.
- Stream large multipart files rather than reading them fully into memory where supported.
- Cache prepared image/reference artifacts by source identity and transform parameters.
- Batch creation lookups and parallelize only lightweight independent resolution with a small cap.

Phase 2 required tests:

- Enqueue more generation jobs than the limit and assert the maximum number running concurrently.
- Assert jobs beyond the limit remain `queued`, and that the worker does not create one waiting task per queued job.
- Restart with several interrupted jobs and verify bounded recovery.

Phase 3 measurements, when the related work is selected:

- Assert an in-flight long job does not cause repeated empty database claims.
- Measure peak resident memory when uploading multiple large video references.

Phase 2 is done when job backlog size cannot directly determine how many generation jobs or spawned waiting tasks exist at once, and excess jobs remain truthfully queued. If polling, upload-streaming, or split-limit work is selected in Phase 3, it is done when a waiting worker produces negligible database activity and peak upload/prep cost is bounded independently of job count.

### P1/P2: ref2video frame peeks repeat expensive uncancellable work

Locations:

- `src/layouts/editor/GenerateMediaRefsForm.tsx`, around lines 198–221.
- `src/layouts/editor/addAssetStartFrame.ts`, frame resolution helpers.

The references form peeks both first and last timeline frames whenever the full `placeholder` or `timeline` object changes. Draft persistence changes those object identities while the user edits generation fields.

A peek can perform creation lookup, local-media resolution or download, reversed-media preparation, thumbnail composition, and FFmpeg frame extraction. Effect cleanup only ignores the completed result; it does not cancel the native, download, or FFmpeg work already in progress.

The older main generation form deliberately uses a stable fingerprint to avoid re-extracting frames while the prompt changes. The new reference form should follow the same policy.

Phase 1 required changes:

- Depend on a stable frame-source fingerprint rather than full timeline and placeholder object identities.
- Deduplicate identical in-flight peeks and cache successful results by source fingerprint.
- Do not re-peek when only prompt, lyrics, or unrelated draft fields change.

Phase 3 follow-up, only if superseded native work still accumulates:

- Add abort/cancellation propagation through Tauri and FFmpeg operations where feasible.

Phase 1 required tests:

- Prompt edits do not trigger new frame peeks.
- Relevant neighboring clip/source changes trigger exactly one first/last refresh.
- Superseded peek results cannot update state.

Phase 3 follow-up test, if cancellation is implemented:

- Superseded native peek work is actually cancelled.

Done when: typing in ref2video performs no media extraction, download, or FFmpeg work unless a frame-source input actually changes.

### P2: editor render synchronously reparses all stored projects

Locations:

- `src/layouts/editor/EditorLayout.tsx`, `outsideReferenceIds` around lines 512–532.
- `src/project/projectStore.ts`, `partitionStoredProjects` and `loadStoredProjectStrict` around lines 273–310.

`outsideReferenceIds` calls `loadStoredProjectStrict(project.id)` directly during render. That path parses the complete `parascene.projects.v1` local-storage value, normalizes every project, and performs strict validation before selecting one project.

The editor rerenders during playback, catalog events, job progress, draft persistence, and ordinary interaction. Playback alone emits time updates at approximately 5 Hz. Synchronous whole-store parsing and normalization therefore blocks the WebView main thread repeatedly and compounds the catalog loop.

Phase 2 required changes:

- Read and normalize project storage once at the owning store/provider boundary.
- Pass the already-normalized open project into the editor.
- Memoize referenced-creation collection from stable project revision and ownership inputs.
- Avoid local-storage reads and whole-project validation in render functions.

Phase 2 required tests and measurements:

- Instrument storage parsing and assert playback/render updates do not invoke it.
- Benchmark large project collections before and after the change.
- Verify outside-reference membership updates when the actual project revision changes.

Done when: editor renders perform no synchronous whole-store parsing or normalization.

### P2: duplicate job watchers and update fan-out

Locations include `src/services/serviceClient.ts`, the direct Blue generation watcher, and global reconciliation in `src/app/ShellProvider.tsx`.

The service watcher subscribes to `jobs-updated` and also polls `serviceGet` every two seconds. Updates are forwarded even when the run is materially unchanged. Direct Blue additionally consumes `blue-run-progress`, and Shell listens to terminal service updates for zombie reconciliation.

This can cause multiple React/external-store updates for one provider change and increases the impact of any leaked listeners.

Phase 3 follow-up changes:

- Make backend job events the primary signal and use polling only as a bounded recovery fallback.
- Compare meaningful run fields before notifying subscribers.
- Consolidate watchers so one backend job has one frontend ownership path.
- Record active listener/watcher counts in development diagnostics.

Done when: one backend state transition produces at most one material frontend store update per consumer, and steady-state polling is absent or negligible.

### P2: project draft persistence still rewrites a large document

Location: `src/layouts/editor/AddAssetGeneratePanel.tsx`, draft persistence around lines 1303 onward.

Version 1.1.51 added a 400 ms debounce because every keystroke previously rewrote the complete project JSON and rerendered the editor. The debounce is a useful mitigation, but sustained typing still serializes and writes a potentially large document every 400 ms.

Phase 3 follow-up changes:

- Keep rapidly changing form state local while the editor is active.
- Persist on a slower idle boundary, blur, clip switch, generation start, or orderly teardown.
- Patch only the relevant project/draft in memory and avoid unrelated normalization work.
- Retain crash/reload recovery expectations with a bounded maximum persistence delay.

Done when: typing latency remains stable for large projects and persistence frequency is intentionally bounded.

## Delivery order

### Phase 1: stop runaway work — done this pass

1. Fix recursive stale-job reconciliation and add the missing regression tests. Done.
2. Fix the picker context/fetch loop and listener cleanup race. Done.
3. Prevent duplicate preview fetching caused by unstable asset arrays. Done.
4. Skip notify/reconcile when `setClips` produces an identical plan. Done.
5. Fingerprint and dedupe ref2video frame peeks. Do not add FFmpeg abort/kill. Done.
6. Add temporary counters for reconciliation calls, catalog loads, listener count, and active FFmpeg/generation work. Done.
7. Verify a release-mode packaged build on the primary development platform. Skipped this pass (low ROI vs unit coverage; still needed before shipping). Reproduce stale `starting` recovery, confirm no stack overflow, and confirm an idle editor with assets does not continuously call `library_get_creations` or accumulate listeners.

### Phase 2: after idle churn is dead

1. Cap generation concurrency with one semaphore acquired before claim/status transition/spawn, leaving excess jobs queued. Done this pass (cap = 2; no worker wakeup rewrite).
2. Move project parsing out of Editor render. Done this pass.
3. If FFmpeg is still encoding the whole timeline while idle, limit automatic baking to a playhead-centered demand window. Skipped this pass (higher product risk; playhead priority already exists).

### Phase 3: deferred I/O and architecture — skipped this pass (low ROI)

1. Longer empty-queue sleep or event-driven worker wakeup, only if SQLite polling is still a measured cost.
2. Cache preview artifact validation metadata.
3. Batch creation lookups and reuse prepared reference media.
4. Stream large Blue uploads. Split network vs FFmpeg vs upload limits only if a single cap is clearly wrong.
5. Consolidate job watchers and suppress materially identical updates.
6. Reduce full-project draft persistence frequency beyond the 400 ms debounce.
7. Kill/abort obsolete FFmpeg bakes and frame peeks only if processes still pile up.
8. Consider a unified project catalog store only if component-level guards were not enough.

### Phase 4: packaged-app performance proof — skipped this pass (low ROI)

This is the broad cross-platform performance matrix. It supplements rather than replaces the narrow Phase 1 packaged verification of the two P0 fixes.

Test release builds on macOS and Windows with:

- A project containing many library assets.
- A long timeline with many dirty preview fragments.
- Several queued and interrupted generation jobs.
- Ref2video using the maximum supported image, video, and audio references.
- Reload during the pre-remote-ID `starting` phase.
- Repeated clip switching and prompt editing during frame previews.

Capture:

- WebView main-thread utilization and render frequency.
- `library_get_creations` calls per minute while idle.
- SQLite connection/query frequency while jobs are waiting.
- Active FFmpeg process count and reason.
- Generation concurrency and peak memory.
- Listener and watcher counts across mount/unmount cycles.
- Time to editor interactivity and input latency.

## Release acceptance criteria

Phase 1:

- No recursive reconciliation path exists; the stale-starting scenario is covered by tests.
- An idle editor with a non-empty asset library performs zero repeated catalog fetches.
- Prompt typing in ref2video does not trigger frame extraction or catalog reloads.
- An unchanged timeline does not rebake or repeatedly reconcile its snapshot.
- Listener/watcher counts return to baseline after component teardown.
- A release-mode packaged build passes the stale-starting recovery scenario and remains idle without repeated catalog calls or listener growth.

Later, after Phase 1 is verified:

- Generation concurrency is explicitly capped.
- Editor playback updates do not parse or normalize the complete stored-project document.
- If idle FFmpeg remains the tax, preview baking is bounded to a demand window without breaking exact coverage.
- Waiting generation jobs do not poll SQLite five times per second.
- Packaged macOS and Windows builds remain responsive under the stress scenarios above.

## Audit validation

At the time of this audit:

- TypeScript typecheck passed.
- ESLint passed without diagnostics.
- All 122 Vitest files and 918 tests passed.
- The working tree was clean and no source changes were made.

The passing suite indicates that these defects are primarily missing lifecycle, repeated-work, concurrency, and performance coverage rather than ordinary compilation failures.
