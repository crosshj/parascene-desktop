# Plan — MV storyboard (Lab)

Replaces `propose` smoke test. Related: [PLAN-song-to-video.md](./PLAN-song-to-video.md).

Pipeline: **Lyric align** → **MV Concept** → **MV Budget** → **MV Scenes**

Golden path: user completes align (timed lyrics, vocals stem), sets aspect ratio, runs modules in order, does not re-align or undo upstream work. Songs ~2–4 min.

---

## Lab modules

- [x] Remove `propose`; add `mvConcept`, `mvBudget`, `mvScenes` to `labTypes`, `labSession`, `labGates`, `LabLayout`
- [x] Gates:
  - [x] `mvConcept`: OpenAI key + lyric align with ≥1 sung timed line
  - [x] `mvBudget`: `storyboardProposal.brainstorm.lockedConcept` exists
  - [x] `mvScenes`: `storyboardProposal.budget` exists
- [x] Extend `LabGateContext`: `hasLockedStoryboardConcept`, `hasStoryboardBudget`
- [x] Nav hint when step done: link to next module (`setModuleId`, like Go to Project groups)

## Lab conventions (reuse existing)

- [x] `run()` + `ModuleChrome` + `ProgressLog` + `actionLabel` for OpenAI jobs
- [x] `lab-last-result` footer = API debug json only (not primary UI)
- [x] Inline persisted state in `lab-module-body` (Lyric align pattern)
- [x] `lab-form`, `primary-btn`, debounced project save (~400ms)
- [x] `openAiChatCompletion` + `OPENAI_STORYBOARD_MODEL` (`gpt-4.1`)
- [x] No internal wizard; module picker is the wizard
- [x] No `activeJob` polling for OpenAI calls
- [x] Reuse `LabLyricCaptionEditor` / `LabMediaWaveform` patterns in scenes timeline
- [x] Extract shared audio path helper from AlignModule for `mvScenes` (`useLabMainAudioPaths.ts`)

---

## Rollout

### Phase 0 — Scaffold
- [x] Three module shells with placeholder copy + gates
- [x] Types on project (empty `storyboardProposal`)
- [x] No fake API calls

### Phase 1 — MV Concept
- [x] `storyboardBrainstorm.ts` + tests
- [x] `LabMvModules.tsx` (`MvConceptModule` — inline, not separate `LabStoryboardBrainstorm.tsx`)
- [x] AI explore: 3–5 concept cards, refine chat, lock
- [x] Manual tab: form → auto-score on lock → lock
- [x] `lockStoryboardConcept()` — same `StoryboardConcept` shape for both paths
- [x] Inline: cards or locked summary + feasibility badge
- [x] Persist full brainstorm history on project

### Phase 2 — MV Budget
- [x] `storyboardBudget.ts` + tests
- [x] Plan budget OpenAI call using locked concept
- [x] Editable budget fields (debounced persist)
- [x] Inline: caps, reuse strategy, section notes
- [x] Re-plan budget without clearing concept

### Phase 3 — MV Scenes
- [x] `storyboardPropose.ts` + tests
- [x] Scene propose OpenAI call using locked concept + budget
- [x] `LabStoryboardEditor.tsx`: timeline, mix/vocals, scene blocks, inspector, drag-resize
- [x] `LabStoryboardPreview.tsx`: animatic preview synced to playback (post-MVP polish)
- [x] Production checklist (computed from proposal)
- [x] Optional export: full JSON + production manifest
- [x] Scene propose failure: budget preserved, retry works

---

## Project persistence

- [x] `project.storyboardProposal: StoryboardProposal | null`
- [x] `project.labStoryboardDirection: string | null` (seed prompt)
- [x] `setOpenProjectStoryboardProposal()`, `setOpenProjectLabStoryboardDirection()`
- [x] `normalizeStoryboardProposal()` on load
- [x] Clear proposal when `mainAudioCreationId` or lyric alignment source changes

### Types (summary)

- [x] `StoryboardConcept` — canonical output of concept step (`source: brainstorm | manual`)
- [x] `BrainstormSession` — turns + `lockedConcept`
- [x] `StoryboardBudget` — caps, reuse strategy, section notes
- [x] `VisualGroup` — shared look + `productionMethod`
- [x] `ProposedScene` — timing, shotType, note, promptHint, lyricLineIndices, productionMethod, reuseFromSceneId
- [x] `ProposedScene.vocalSlice` — auto-derived for lip-sync (`inSec/outSec` = scene times)
- [x] `ProposedScene.vocalSliceWarning` — if outside vocalActivity

---

## OpenAI — three calls across modules

### MV Concept (`storyboardBrainstorm.ts`)
- [x] Generate options: 3–5 cards with feasibility 0–100 + rationale + tradeoffs
- [x] Refine: one updated option + re-score
- [x] Manual lock: score-only call (no new ideas)
- [x] Payload: duration, aspect ratio, title, seed prompt, lyric structure (tags + sung lines), vocalActivity, productionAwareness, styleHints
- [x] Do not send full Whisper words
- [x] Feasibility rubric tied to pipeline cost (not creative quality alone)

### MV Budget (`storyboardBudget.ts`)
- [x] Input: locked concept + lyric structure + production constraints
- [x] Output: maxUniqueStills, maxUniqueVideoMasters, targetSceneCount, reuseStrategy, sectionNotes
- [x] User can edit numbers before scenes step
- [x] Parser tolerates nested/snake_case OpenAI responses

### MV Scenes (`storyboardPropose.ts`)
- [x] Input: locked concept + budget (hard caps) + lyric structure + vocalActivity + shot catalog with descriptions
- [x] Output: visualGroups + scenes (tile full duration, no gaps/overlaps)
- [x] Hybrid reuse: visualGroupId + productionMethod per group; validate impossible lip-sync clip reuse
- [x] Post-process: tiling, budget count check, vocalSlice derive
- [ ] Post-process: maxShotSec split (constraint sent to model; no server-side split yet)
- [ ] Human can override productionMethod per scene in editor

### Shot catalog
- [x] `LAB_SHOT_CATALOG` with one-line descriptions in every AI payload

---

## MV Concept UI

- [x] Tab: Explore with AI | I have my direction
- [x] Seed prompt → debounced `labStoryboardDirection`
- [x] `activeLane` for brainstorm / refine / score (Align pattern)
- [x] Lock concept → direct project write (not `onRun`)
- [x] Low feasibility: warn, still allow lock

---

## MV Scenes UI

- [x] Mix / vocals playback toggle
- [x] Scene lane colored by visualGroupId
- [x] Visual group color key / legend below timeline
- [x] Read-only lyric context optional
- [x] Inspector: shotType, note, promptHint, timing
- [x] Waveform click-to-seek
- [x] Debounced persist on edits
- [x] No add/delete/split scenes
- [ ] Inspector: productionMethod override

---

## Out of scope (this phase)

- [ ] Staleness when lyrics re-align
- [ ] Revise concept without clearing budget/scenes
- [ ] Aspect ratio change invalidation
- [ ] Director / Editor handoff
- [ ] Auto-trigger Lab create / a2v / extend from scenes
- [ ] Editor clip placement
- [ ] Per-scene generation status
- [ ] OpenAI payload limits / compaction for long songs

---

## Key files

- `src/layouts/lab/labTypes.ts`, `labGates.ts`, `LabLayout.tsx`
- `src/lab/labSession.ts`, `openaiClient.ts`
- `src/lab/storyboardBrainstorm.ts`, `storyboardBudget.ts`, `storyboardPropose.ts`
- `src/lab/LabMvModules.tsx`, `LabStoryboardEditor.tsx`, `LabStoryboardPreview.tsx`
- `src/lab/storyboardVisualGroups.ts`, `useLabMainAudioPaths.ts`
- `src/project/types.ts`, `projectStore.ts`, `storyboardNormalize.ts`
- `src/app/ShellProvider.tsx`
- `src/styles.css`

---

## Test checklist

- [x] Scaffold: three modules, gates, `propose` removed
- [x] Unit tests: `storyboardBrainstorm`, `storyboardBudget`, `storyboardPropose`, `labGates` (MV gates)
- [ ] Concept: AI cards, refine history, manual auto-score, lock persists (manual QA)
- [ ] Budget: uses concept, editable, persists (manual QA)
- [ ] Scenes: full timeline, visual groups, vocalSlice, retry on failure (manual QA)
- [ ] Mix/vocals playback, inspector edits persist (manual QA)
- [x] Export downloads work (implemented; manual QA recommended)
