# Plan — Timeline fill (continuity-first MV)

**Status:** Proposed direction (replaces MV Build checklist approach)  
**Date:** July 2026  
**Supersedes:** [mv-build-retrospective.md](./mv-build-retrospective.md) (abandoned path)  
**Related:** [PLAN-song-to-video.md](./PLAN-song-to-video.md), [PLAN-mv-storyboard-lab.md](./PLAN-mv-storyboard-lab.md)

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

Per placeholder, the user chooses how this shot connects to what came before. Examples:

| Option | Meaning |
|--------|---------|
| **Use previous end frame** | Seed generation from the last frame of the clip immediately before this slot on V1 |
| *(later)* **Use specific asset** | Pick any project still or clip frame |
| *(later)* **Fresh still** | Text-to-image with no visual chain |
| *(later)* **Same setup / match cut** | Semantic presets tied to storyboard notes |

**"Use previous end frame"** alone is enough for an MVP that fixes the main pain: each new shot can visually continue from the last one without a separate planning pass.

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
3. **Configure slot** — duration, continuity option (e.g. previous end frame), tweak auto-filled lyric/prompt text.
4. **Generate** — one button per placeholder; replaces ghost with real asset when done; keeps timeline position.
5. **Repeat** — next slot naturally follows the previous clip on the timeline; continuity option makes that explicit.

Progress = **what's filled on the timeline**, not "47 of 53 checklist steps."

---

## What this is not

- Not a factory checklist (MV Build).
- Not automatic continuity without user choice—the user picks "use previous end frame" (or other options later).
- Not perfect on day one—good enough to direct shot-by-shot on the timeline.

---

## Relationship to existing pieces

| Existing | Role in new model |
|----------|-------------------|
| **Lyric align** | Supplies timed text for any `[start, end]` window |
| **MV Scenes** | Proposes scenes + times → can **spawn placeholders** on timeline (import), not run generation |
| **MV Build** | **Retired** — logic like pull_frame / a2v / file-to-group moves to per-placeholder Generate |
| **Editor timeline** | Primary surface; needs unfilled clip type + fill UI |
| **AI Fill** (song-to-video plan) | Same spirit: ghost clip, generate, keep song audio — extend to continuity options |
| **`TimelineGhostClip`** (today) | Drag preview only — **new type** needed for persistent unfilled slots |

---

## MVP scope (suggested)

### Data model

- Extend `TimelineClip` (or parallel fill target) with:
  - `fillStatus`: `empty` | `generating` | `filled`
  - `continuity`: `{ mode: "previous_end_frame" } | …`
  - `generationSpec`: prompt, vocal slice ref, optional storyboard scene id
  - `assetId` when filled (null while empty)

### Editor UI

- [ ] Add placeholder clip to timeline (empty V1 slot with duration)
- [ ] Snap / align to lyric or scene markers
- [ ] Marker row or scene strip under timeline
- [ ] Inspector: continuity dropdown, lyric-assisted prompt, **Generate**
- [ ] Visual distinction: unfilled vs filled clips

### Generate pipeline (per clip)

- [ ] Resolve continuity (e.g. extract last frame of previous V1 clip)
- [ ] Resolve vocal slice + lyrics for clip time range
- [ ] Run still / a2v (reuse Lab primitives: isolate, `ltx_a2v`, file to Videos group)
- [ ] Swap placeholder → real clip; preserve `startSec` / duration

### Storyboard handoff

- [ ] "Send scenes to timeline as placeholders" from MV Scenes (optional MVP+1)
- [ ] Do not auto-generate entire MV

---

## Later

- [ ] More continuity modes (specific asset, style lock, character lock)
- [ ] Batch generate all empty placeholders in timeline order
- [ ] Regenerate in place (keep slot, new asset)
- [ ] First–last frame bridge between two filled clips
- [ ] Director as primary entry (Lab storyboard becomes optional depth)

---

## Open questions

1. **Placeholder duration** — user-drawn, fixed from scene `endSec - startSec`, or shrink-to-fit lyrics?
2. **One V1 lane only** for MVP, or multiple video tracks?
3. **Filled clip** — replace placeholder in place vs new clip + delete ghost?
4. **Storyboard drift** — if user moves placeholder off scene time, is scene link advisory only?

---

## Success criteria

- User can place an **empty** clip at 0:13–0:25, see **lyrics for that window**, choose **previous end frame**, hit **Generate**, and get a lip-sync clip **on the timeline** without using MV Build.
- Watching the timeline left-to-right matches the **story order** of the video.
- Continuity is a **visible choice per slot**, not a hidden default in a plan resolver.
