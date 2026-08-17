# Plan — Timeline fill (continuity-first MV)

**Status:** Core Editor Generate path **shipped** (placeholders, independent first/last sources, multi-server, Result | Form, Generate new with durable frame stamps). Marker/scene strip and batch flows remain open.  
**Date:** July 2026 (status refreshed August 2026)  
**Supersedes:** [mv-build-retrospective.md](./mv-build-retrospective.md) (abandoned path)  
**Related:** [PLAN-song-to-video.md](./PLAN-song-to-video.md), [PLAN-mv-storyboard-lab.md](./PLAN-mv-storyboard-lab.md), [PLAN-parascene-blue-direct.md](./PLAN-parascene-blue-direct.md)

---

## Principle

**The user provides continuity; the app handles lyrics and mechanics.**

MV Scenes / Lab storyboard work can still propose *what* happens when, but **generation is driven from the Editor timeline**, not a detached step table. Each gap on the timeline is a slot the user places and configures; the backend fills in lyric context and runs generation on demand.

Continuity is explicit and visual: you see what came before, what you're filling, and how it lines up with the song.

---

## Core idea

### Placeholder clips on the timeline

A clip can exist on the timeline **before** it has a generated asset.

- It has **start time** and **duration** (aligned to markers / scenes / lyrics).
- It appears as a distinct **unfilled** or **ghost fill** clip (not the same as today's drag-preview ghost).
- Selecting it opens **fill options** and a **Generate** action.

This is the unit of work—not a row in MV Build.

### Continuity options (user-controlled)

Per placeholder, the user chooses how this shot connects to what came before:

| Option | Meaning | Status |
|--------|---------|--------|
| **Previous / next timeline neighbor** | Seed from last frame of prior clip and/or first frame of next | **Shipped** |
| **Project image (Assets)** | Pick any project still for first and/or last independently | **Shipped** |
| **None** | Text-to-video (no input stills) | **Shipped** |
| *(later)* **Same setup / match cut** | Semantic presets tied to storyboard notes | Open |

First and last are **independent** (timeline neighbor, Assets image, or none) via the frame-source picker — not an all-or-nothing bridge.

### Lyrics and timing — app-assisted, not user-managed

When a placeholder is selected (or when Generate is pressed):

1. Read the clip's **time range** on the timeline.
2. Pull **aligned lyrics** (and vocal slice bounds) for that window from `lyricAlignment` / storyboard scenes.
3. Pre-fill prompt hints, shot notes, or a short "what to generate" summary—the user edits if they want, but doesn't hunt lyrics manually.

The user worries about **continuity and creative intent**; the system worries about **which words fall in this segment**.

### Markers and scenes under the timeline

The Editor should show **context under the timeline**, not only tracks:

- **Lyric / scene markers** — from storyboard or align output, so placeholders snap or align visually.
- **Scene bands** (optional) — labeled regions showing MV Scenes proposals under the same time axis.

Placeholder placement and marker alignment are the same coordinate system: seconds on the main audio.

---

## User flow (target)

1. **Align + storyboard** (Lab or Director) — lyrics timed, scenes proposed with time ranges. No bulk generation required.
2. **Editor** — main audio on A1; user adds **fill placeholders** on V1 (from storyboard import, drag to create, or "add scene as placeholder").
3. **Configure slot** — duration, first/last sources, server + model, tweak auto-filled lyric/prompt text.
4. **Generate** — one button per placeholder; Result | Form dual view while running; replaces ghost with real asset when done; keeps timeline position.
5. **Review / Generate new** — finished gens show Result | Form; Form keeps stamped first/last stills; Generate new clones prompt + durable frame sources.

Progress = **what's filled on the timeline**, not "47 of 53 checklist steps."

---

## What this is not

- Not a factory checklist (MV Build).
- Not automatic continuity without user choice—the user picks first/last sources.
- Not perfect on day one—good enough to direct shot-by-shot on the timeline.

---

## Relationship to existing pieces

| Existing | Role in new model |
|----------|-------------------|
| **Lyric align** | Supplies timed text for any `[start, end]` window |
| **MV Scenes** | Proposes scenes + times → can **spawn placeholders** on timeline (import), not run generation |
| **MV Build** | **Retired** — logic like pull_frame / a2v / file-to-group moves to per-placeholder Generate |
| **Editor timeline** | Primary surface; add-asset placeholders + Generate panel |
| **AI Fill** (song-to-video plan) | Same spirit: ghost clip, generate, keep song audio — extend to continuity options |
| **`TimelineGhostClip`** (today) | Drag preview only — **persistent** unfilled slots are add-asset placeholders |

---

## MVP scope

### Data model

- Extend `TimelineClip` (or parallel fill target) with:
  - `fillStatus`: `empty` | `generating` | `filled`
  - `continuity`: `{ mode: "previous_end_frame" } | …`
  - `generationSpec`: prompt, vocal slice ref, optional storyboard scene id
  - `assetId` when filled (null while empty)

**Shipped shape (practical):** `isAddAssetPlaceholder` + `addAssetDraft` / `addAssetGeneration` (intent, server, first/last `AddAssetFrameSource`, preview URL stamps, remote job resume).

### Editor UI

- [x] Add placeholder clip to timeline (empty V1 slot with duration)
- [ ] Snap / align to lyric or scene markers
- [ ] Marker row or scene strip under timeline
- [x] Inspector / Preview: continuity (first/last sources), lyric-assisted prompt, **Generate**
- [x] Visual distinction: unfilled placeholders vs filled clips
- [x] Result | Form dual view (sticky Form when browsing finished gens)
- [x] Generate new from a finished generation (clones prompt + durable frame stamps)

### Generate pipeline (per clip)

- [x] Resolve continuity (neighbor extract and/or Assets stills; independent first/last)
- [x] Resolve vocal slice + lyrics for clip time range (when audio intents need it)
- [x] Run still / i2v / flf / a2v / t2v via Parascene, Direct to Blue, or Replicate
- [x] Swap placeholder → real clip; preserve `startSec` / duration
- [x] Stamp first/last preview URLs + durable image sources on success (Form / Generate new)

### Storyboard handoff

- [ ] "Send scenes to timeline as placeholders" from MV Scenes (optional MVP+1)
- [ ] Do not auto-generate entire MV

---

## Later

- [ ] More continuity modes (style lock, character lock)
- [ ] Batch generate all empty placeholders in timeline order
- [x] Regenerate / Generate new (keep creative inputs, new asset)
- [x] First–last frame bridge between neighbors (and Assets picks)
- [ ] Director as primary entry (Lab storyboard becomes optional depth)

---

## Open questions

1. **Placeholder duration** — user-drawn, fixed from scene `endSec - startSec`, or shrink-to-fit lyrics?
2. **One V1 lane only** for MVP, or multiple video tracks?
3. **Filled clip** — replace placeholder in place vs new clip + delete ghost? *(shipped: replace in place)*
4. **Storyboard drift** — if user moves placeholder off scene time, is scene link advisory only?

---

## Success criteria

- User can place an **empty** clip, choose **previous end frame** (or Assets stills / first+last), hit **Generate**, and get a clip **on the timeline** without using MV Build.
- Finished gens keep **Form** review of the submitted prompt and first/last stills; **Generate new** does not depend on live neighbors alone.
- Watching the timeline left-to-right matches the **story order** of the video.
- Continuity is a **visible choice per slot**, not a hidden default in a plan resolver.
