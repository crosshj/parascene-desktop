# Plan — Image clip preview (canvas)

Make image staging controls (**Duration**, **Motion**, **Framing**) drive a real preview: playable, scrubbable, with Ken Burns / Hold, and visible **overspill** outside the project frame.

Today those fields are stored on the staged draft / timeline clip, but the preview is a static `<img>`. Transport (`canPlay`) only arms for video/audio.

## Goals

1. **Timed image clip** — Duration is the clip length. Play / pause / scrub / skip use a virtual clock `t ∈ [0, duration]`.
2. **Framing** — Fit / Fill / Stretch control how the image is placed in the project aspect rectangle.
3. **Motion** — Hold stays fixed; Ken Burns animates pan/zoom over `t` (one good default path first).
4. **Overspill** — Show the part of the image outside the project frame, **dimmed**, so crops and Ken Burns are editable by eye (not a hard crop-only stage).
5. **Canvas stage** — One draw path: `renderImageClip(draft, t, projectAspect) → canvas`, so preview can later share math with export / compose.

## Non-goals (this pass)

- Full timeline sequence playback (multi-clip compose) — see [PLAN-preview-mse.md](./PLAN-preview-mse.md)
- Export / FFmpeg encode of the staged image clip ([PLAN-ffmpeg.md](./PLAN-ffmpeg.md) readiness is separate)
- Multiple Ken Burns presets, manual keyframes, or per-clip motion editors
- Fit / fullscreen chrome controls (still deferred in the preview deck)

**Superseded for program monitor:** Replacing timeline `<video>` is done via Rust fMP4/MSE ([PLAN-preview-mse.md](./PLAN-preview-mse.md)). This canvas plan remains relevant for **source staging overspill** UX.

## Settled UX

| Decision | Choice |
| --- | --- |
| Render surface | **Canvas** (not CSS transform of a clipped `<img>`) |
| Outside project frame | **Dimmed overspill** — full transformed image visible; exterior darkened; frame edge clear |
| Scope | **Image kind only** for this plan; video/audio keep current media elements until a later compose pass |
| Fidelity bar | Editor preview that *feels* correct; pixel-identical export can come later on the same draw math |

## Why canvas

CSS can fake Ken Burns, but overspill + framing + seekable motion wants a single place that owns:

- Source image size
- Project aspect rect (letterbox inside the stage)
- Framing → source/dest (or crop) rects
- Motion → transform at `t`
- Dim pass outside the project rect

That same `render at t` function is the seed for export/timeline compose later. CSS matte-over-cropped-media cannot show Fill/Ken Burns overspill cleanly.

## Suggested compose model

```
┌─────────────────────────────────────────┐
│ Stage (preview surface, e.g. 16:9)      │
│                                         │
│   ┌───────────────────────────────┐     │
│   │ Project frame (aspectRatio)   │     │
│   │   bright / sharp image        │     │
│   └───────────────────────────────┘     │
│     dimmed continuation of image        │
│     (overspill — clipped by stage only) │
└─────────────────────────────────────────┘
```

Per animation frame (or scrub):

1. Clear stage.
2. Load/decode source bitmap (cache `HTMLImageElement` / `ImageBitmap` by asset URL).
3. Compute **base placement** from Framing inside the project rect (Fit / Fill / Stretch).
4. Apply **Motion** at `t` (Hold = identity; Ken Burns = scale + translate along a preset path over `[0, duration]`).
5. Draw the full transformed image (may extend past the project rect).
6. Darken everything **outside** the project rect (fill with translucent black, or destination-in mask).
7. Stroke the project frame; keep the existing aspect label if useful.

Transport:

- For image drafts, `canPlay` becomes true when a bitmap is ready (not only video/audio).
- Scrubber `max = staged duration`; `currentSec` driven by rAF while playing; stop or loop at end (decide at implement time — prefer **stop** first).
- Changing Duration / Motion / Framing updates the next draw; keep `t` clamped into the new duration.

## Suggested code shape

Keep wiring in the existing editor preview; extract draw math so it is testable without the full pane.

| Piece | Likely home |
| --- | --- |
| Clip clock (play / seek / rAF) | `PreviewPane` or small `useClipClock` helper |
| Draw function + Ken Burns math | e.g. `src/layouts/editor/imageClipRender.ts` (pure-ish) |
| Canvas element + DPR resize | Image branch of preview stage (replace static detail `<img>` when `kind === "image"`) |
| Staging fields | Already in `PreviewStaging` / `StagedClipDraft` — no schema change required for v1 |

Reuse:

- `stagedDraft.duration` / `stagedClipDuration`
- `project.aspectRatio` + existing aspect helpers
- Transport UI already in the preview deck

## Phases

### Phase 1 — Canvas stage + clock + framing

- Canvas sized to the preview surface; bitmap from local detail/thumb URL
- Virtual clock; enable play / scrub for images
- Framing Fit / Fill / Stretch inside project rect
- Dim overspill + frame outline (replace or fold today’s CSS matte for the image path)

### Phase 2 — Ken Burns

- One default path (e.g. slow zoom-in with slight pan)
- Hold = no motion
- Scrub updates transform; play runs for full Duration
- Later control UX: see note below (start/end frames + easing)

### Phase 3 — Harden / share

- Unit tests for placement + motion at `t = 0 / 0.5 / 1`
- Heal stored clip thumbs already done separately; keep canvas thumb source from the same asset URL
- Optional: write corrected framing/motion into timeline on edit (already wired for draft fields)
- Later: export / timeline compose call the same render helper (out of scope until FFmpeg/export plans pick it up)

## Note — Ken Burns controls (reference)

When we graduate from a single preset to **editable** Ken Burns, use an FCPX-style crop/motion UI rather than abstract numeric fields only:

- [FCPX 10.1 — New Ken Burns Controls (Dan Allen)](https://www.youtube.com/watch?v=VddMB0Eme_A)
- **Start / end frames** drawn on the image (green = start crop, red = end crop); drag handles to set pan/zoom path over Duration
- **Easing** on the path: linear (constant speed), ease in, ease out, ease in–out — so the move doesn’t hard-stop at the end frame
- Overspill + dimmed exterior (this plan) pairs well with that: you can see and grab the parts of the image outside the project frame while shaping start/end

v1 can still ship Hold + one auto path; this note is the target for the motion editor controls.

## Effort (rough)

| Slice | Estimate |
| --- | --- |
| Phase 1 | ~1 day |
| Phase 2 | ~0.5–1 day |
| Phase 3 (tests + polish) | ~0.5 day |
| **Total** | **~2–2.5 days** for a solid editor preview |
| Editable start/end + easing UI | Later — not in the Phase 1–3 estimate |

## Open decisions (when implementing)

- Stop vs loop at end of Duration
- Exact Ken Burns path (zoom-in center vs start-wide pan); keep a single preset until a motion picker exists
- How dark the overspill dim is; whether overspill is clipped to the stage only
- Thumb vs full-res bitmap while scrubbing (start with whatever `creationDetailUrl` / preview URL already uses)
- Whether the CSS aspect matte stays for video/audio while images use the canvas dim pass only
- When to add FCPX-style start/end frame handles + easing (after canvas preview works)

## Related

- Staging model: `src/layouts/editor/stagedClip.ts`, `PreviewStaging.tsx`
- Preview shell: `src/layouts/editor/PreviewPane.tsx`
- Ken Burns control reference: [YouTube — FCPX Ken Burns controls](https://www.youtube.com/watch?v=VddMB0Eme_A)
- FFmpeg / export later: [PLAN-ffmpeg.md](./PLAN-ffmpeg.md)
- Editor mock reference: [mockups/editor.png](./mockups/editor.png)
