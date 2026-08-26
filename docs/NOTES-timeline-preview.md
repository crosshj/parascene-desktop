# Notes: timeline preview playback

Terse follow-ups from the MSE / preview-quality work. Not a plan — just things worth remembering.

## Lessons (do not regress)

- Contiguous `SourceBuffer.buffered` is required. Sequential fragments must merge to one range (e.g. `[0, 8]`), not gaps at every boundary.
- FFmpeg `setpts` and `-output_ts_offset` do not reliably set CMAF `tfdt`. Keep the post-encode binary `tfdt` patch (10000-tick timescale).
- Clock: baked audio is master; snap video to audio on drift. Video-master + audio re-seek causes choppy audio.
- Preview visuals come only from the fragment stream when the cache is active — never fall back to full-res decoder-pool video for scrub/play.
- MSE codec string must match encoder level. High (960×540) needs baseline ≥ 3.1 (`avc1.42E01F`). Bump again if presets grow.
- Do not `destroy()` the fragment cache on EditorLayout effect cleanup (Strict Mode remount kills rebuild).

## Possible later work

- Scale stall / wrap thresholds with active preview fps (today sized for Low / 10fps).
- High bake cost: 30fps × 960p is ~3× Low frames. If rebuild feels slow: more parallel encodes, or a “High but 15fps” preset.
- Quality is app-global (`localStorage`). Per-project override only if users ask.
- Prefer an upstream Tauri fix for stale `unregisterListener` over the webview guard.
- Verbose MSE/tfdt console logging can drop once playback stays stable.
