# MV Build — retrospective / frustration log

**Date:** July 2026  
**Status:** Abandoned for now

## Decision

Pause work on the **MV Build** module (`mvBuild` Lab step). The current approach treats generation as a factory line of independent shots rather than a connected sequence.

**Way forward:** [PLAN-timeline-fill.md](./PLAN-timeline-fill.md) — user-placed placeholder clips on the Editor timeline, continuity options per slot, lyric-assisted generate.

---

## Core complaint

**Scenes are planned and built in isolation.** Each step knows its own prompt and mechanical dependencies (still → a2v → place), but there is **no model of continuity** from one moment to the next. After clip 1 is created and placed, clip 2 appears as a new row in a table—not as a deliberate continuation of what the viewer just saw.

---

## What felt broken

### 1. No narrative or visual continuity between scenes

The plan never asks: *What changed? What stayed the same? What's the bridge from the previous shot?*

"Last frame of previous clip" is a technical chain, not a creative decision about how scenes connect.

### 2. Planning and execution are disconnected

**MV Scenes** defines a storyboard; **MV Build** turns it into a flat checklist. The build step doesn't inherit intent from the prior scene—only whatever default still/frame rule applies at that moment.

### 3. Progress tracking doesn't match the mental model

Steps can complete out of timeline order. Statuses don't always match what actually ran. "8 / 53 done" doesn't feel like "we're through the intro." The UI tracks **tasks**, not **story progress**.

### 4. Reference images are bolted on, not foundational

Picking a still or frame per step helps technically, but it doesn't answer: *Why this image for this moment, given everything before it?*

### 5. Groups vs timeline vs shots

Visual groups, scene order, and timeline placement fight each other. Work can happen on "later" scenes while earlier ones look stuck, which breaks the sense of building a video sequentially.

### 6. Steps not marking done / progress out of sync

Even when generation succeeded (image or clip created), the plan sometimes failed to mark the right step DONE or advance to the next runnable step—undermining trust in the build UI.

---

## What was actually wanted (implicit)

A pipeline where each new scene is **explicitly grounded in what came before**—visually, temporally, and narratively—not merely "previous clip's last frame" as an optional dropdown.

---

## What the current system actually does

| Layer | Behavior |
|-------|----------|
| **MV Scenes** | Proposes scenes, visual groups, production methods per group |
| **MV Build** | Resolves a generation plan (stills, pull_frame, a2v/i2v, place_clip), runs or marks steps done |
| **Chaining** | Per-step still/frame source: group still, project image, or last frame of previous video |
| **Ordering** | Groups ordered by earliest scene on timeline; steps sorted within that structure |
| **Persistence** | `generationPlan` on `storyboardProposal` with reconcile + patch on each update |

This is sufficient for **batch-producing assets per scene** but not for **directing a continuous music video**.

---

## Likely direction if revived

See **[PLAN-timeline-fill.md](./PLAN-timeline-fill.md)** — continuity-first, timeline placeholder clips, user-chosen options (e.g. previous end frame), lyric-assisted generate. Not the MV Build checklist.

---

## Code touched (for archaeology)

- `src/lab/LabMvBuildModule.tsx` — Build UI
- `src/lab/storyboardBuildPlan.ts` — Plan resolver, materialize, reconcile
- `src/lab/storyboardBuildRun.ts` — Step execution
- `src/layouts/lab/labTypes.ts` — `mvBuild` module id
- `src/project/types.ts` — `StoryboardGenerationPlan`, `VideoStillSource`
