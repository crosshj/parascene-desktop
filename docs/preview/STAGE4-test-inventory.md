# Stage 4: preview test inventory

Maps failure-map F-numbers to coverage. jsdom = unit/policy tests. Packaged = manual or future automation on macOS WKWebView and Windows WebView2.

## jsdom covered (automated)

- F4/F14 stale generation: mseFragmentPlayer generation discard test; cache bake epoch fencing
- F5 depwait: timelineFragmentCache + timelinePlaybackEngine tests
- F7 leases: Rust preview_prune_skips_leased_fragment_files
- F9 sample clock: Rust fragment_artifact_matches_plan_checks_tfdt_and_sample_count
- F10 CSP fetch: mseFragmentPlayer fetch failure test
- F11 404 rebake: mseFragmentPlayer 404 + cache invalidateFragmentAtPath test
- F13 fetch timeout: mseFragmentPlayer FETCH_TIMEOUT_MS (detector exists; hang test partial)
- F15 append error: reset path in mseFragmentPlayer (event wired; full MSE mock limited)
- F21 stale append: generation token on queue items
- F29 skip hole removed: timelinePlaybackEngine admission policy tests
- F30 fail-open removed: same
- I1 admission hold: ensurePlayableWindow + engine tests

## Accepted risk — packaged-only until soak suite exists

- F2 FFmpeg hang / bake deadline
- F16 quota trim under real SourceBuffer pressure
- F18–F20 MSE session wedge / sourceopen hang / updateend hang
- F19 sourceopen hang (10s watchdog exists; WKWebView soak not automated)
- F23–F26 decoder stall, play() rejection, long-run boundary hitch
- F34 remount during active bake (session hoist mitigates; no automated WKWebView test)
- F37 CSP packaged-only regression (media:// connect-src)
- Soak: every 2s boundary for N minutes without skip/stale/live-decoder fallback

## Accepted risk — deferred past stage 3

- A6 full cryptographic fragment identity (FNV retained; Rust config owns encode tag)
- Full Rust-side plan canonicalization (fingerprints still computed in FE with Rust encode tag)

## Done criteria for stage 4

- Every F-number above is either jsdom/Rust tested or listed here with reason
- Packaged manual checklist in PLAN-preview-playback.md stage 4 run once per release candidate
- Soak test script or accepted-risk sign-off before calling preview closed
