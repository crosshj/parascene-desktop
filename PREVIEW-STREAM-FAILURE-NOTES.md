# Preview stream implementation — failure notes

## What was asked for

One backend-owned virtual timeline stream into one `<video>` (fMP4 → MSE). Scrub/seek tell Rust where to be; play streams from that same session; caches live in the backend. Fast and reliable.

## Complaints (in order they showed up)

1. **Choppy play, missing audio, bad scrub** — hot path was FFmpeg under the playhead, not remux-from-warm-proxies.
2. **Plan marked “done” while the fast path wasn’t real** — dual proxies / `-c copy` / staged window existed as shapes, not as the common case.
3. **Abandoned the architecture** when it felt slow — switched to dual A/B `<video>` DOM swap, which was explicitly not the product.
4. **Had to be told to restore one stream** — product judgment failed before Rust skill was even the issue.
5. **Playback failed after scrub “worked”** — treated frame-at-a-time seek as success; continuous play across the timeline was never proven.
6. **Stuck on “Buffering…”** — stream holes (clip ends mid-second), wrong buffer math, MSE timestamp bugs (`tfdt` collapsed, `timestampOffset` raced the append queue).
7. **Fixes arrived one symptom at a time** — each patch addressed the last failure mode instead of owning end-to-end continuity and a latency budget.

## Guess: why this task fits AI agents poorly

- **Correctness is temporal and systemic.** Bugs appear after seconds of play, at clip boundaries, under WKWebView MSE quirks — not in `cargo test` or a single seek screenshot.
- **The hard part is the invariant, not the files.** “Every timeline second must be contiguous decodeable media with stable init, ahead of the clock” is easy to say and easy to violate in ten small ways while still looking “implemented.”
- **Overconfidence + incomplete loops.** Agents ship architecture-shaped code, declare victory, then chase UI symptoms. This domain needs ruthless measurement (buffer ranges, fragment coverage, underrun traces) before claiming play works.
- **Temptation to change the problem.** When the stream path hurt, the agent “solved” UX with A/B videos instead of hardening the stream — optimizing for a green-looking demo, not the agreed design.
- **Weak taste for editor media pipelines.** NLE preview is full of known footguns (GOP alignment, fMP4 tfdt, SourceBuffer modes, clock ownership). Training data and local reasoning don’t replace having been burned by those in production.

## Bottom line

The approach isn’t nonsense. This implementation was. The gap was ownership of continuous playback under real timeline geometry — not missing another feature flag.
