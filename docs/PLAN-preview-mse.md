# Plan — Rust-owned fMP4 / MSE timeline preview

**Status:** Required architecture (one backend stream → one `<video>`)  
**Related:** [PLAN-backend-ownership.md](./PLAN-backend-ownership.md)

## Goal

Program monitor uses **one** persistent `<video>`. Rust owns the virtual timeline stream (clip selection, proxy remux, composition cache, audio mix, staging). React only sends commands (`setTimeline`, `play`, `pause`, `seek`) and appends fragment bytes into MSE.

**Not acceptable:** swapping `video.src` per clip, dual A/B DOM video decks, or FE-owned multi-decoder playback for the program monitor.

## Architecture

```text
Import / ensure local
  → dual normalized fMP4 proxies (playback + scrub) under Cache/proxies/v1
  → catalog proxy_* fields

Editor timeline commands
  → PreviewSession (Rust)
      ├── remux cut spans (-c copy / cached)
      ├── compose cache (Ken Burns, framing, slideshow, reverse, transitions)
      └── staged window ahead of playhead
  → fragment bytes (media:// or IPC)
  → MSE SourceBuffer
  → single <video>
```

## Contract

| Action | Who |
| --- | --- |
| Scrub / seek | FE tells backend playhead; backend stages that region of the **same** stream |
| Play | Backend keeps staging ahead; FE plays the one `<video>`; UI playhead follows stream clock |
| Cache | Backend owns proxy + remux/compose caches |

## Proxies

| Kind | Policy |
| --- | --- |
| Playback | 1280×720, 30fps, H.264 main, AAC, fMP4 |
| Scrub | 640×360, all-intra, same audio, fMP4 |

Export still uses originals (`render.rs`).

## FE surface

[`TimelinePreviewPlayer`](../src/layouts/editor/TimelinePreviewPlayer.tsx) — single MSE `<video>` only.
