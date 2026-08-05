# Plan — Image composition and editing (still workstream)

Also see: [BACKLOG-desktop.md](./BACKLOG-desktop.md) — stills as first-class shot setup; prepare model inputs rather than fight the edit. Reference sheets feed characters, environments, and reference-package assembly (#8–#10).

## Principle

Prefer preparing a strong still over compensating later in video.

Composition is not a one-shot stitch. It is an iterative still workstream: layout → candidates → AI edits → more candidates → pick what works → discard transitional noise. Stay local. The timeline is not involved until an accepted still is used as a frame, reference, or promoted into a clip.

**Entry point:** Selection → Composite → **Create composition**. That creates a composition in Assets (record + sandbox + group). Plate joins and AI edits happen *inside* that composition. Nothing from the stream becomes its own Assets item until the user explicitly promotes it (**Add selected to Assets**).

Layout options are creative controls. Flush abut, intentional gap for AI fill, outer margins/bars, and multi-panel sheet grids are all valid recipe choices—not only cosmetic.

## What this is

A **composition** (still workstream): sources + layout recipe + optional bake history, reopenable in the preview pane.

It has two jobs, and both can be true at once:

1. **Group / folder-like** — related stills can sit under a composition so the assets list stays clean. Membership is shared; **visibility is per image**.
2. **Bake / generate** — produce new stills (plate or sheet) into assets from the recipe. Bakes and AI-edit descendants are additional assets tied to the composition’s stream.

**Show outside** is a **per-image** flag (member or bake), not a single composition-wide facade. Each image chooses whether it appears at the assets-list top level or only when you open the composition.

- **Pop out** — mark an existing member (or bake) visible outside so you can use it anywhere without leaving the composition. Same asset; not a copy.
- **Bake** — create a **new** image from the recipe (and later AI edits of that bake).

So “I need the owl alone again” is pop-out. “I need owl+human as one plate” is bake.

It is not:

- A timeline clip — wrong target; timeline assembles accepted media
- Only a dumb folder — it also has a recipe, bake stream, and “where we left off”
- Only a single baked file — members remain addressable without cropping the bake

It is:

- Starts from a selection and a layout recipe (how the inputs go together)
- May group those sources under one assets-list entry
- May bake candidate stills (local layout, then AI edits) that appear as new assets
- Reopens in the preview pane: browse members, moments in the bake stream, branch, continue
- Lets you pick a member or a bake for first/last frame, reference use, or other input
- Lets you discard transitional bakes without losing sources or the accepted result

## Members vs bakes (simple addressing)

No need to recover individuals from flattened pixels.

- **Members** = the source images in the composition (always real assets)
- **Bakes** = new images generated from the recipe (and AI edits of those)
- **Show outside** = per-image visibility in the assets list (default: members hidden at top level, selected bake visible)
- **Pop out** = set show-outside on an existing member/bake so it is usable at top level; still belongs to the composition
- **Bake** = create a new asset from the recipe
- “Use the front-view” / “swap the left slot” → member (via slot → source)
- “Use this sheet as reference” / “gap-fill this plate” → bake (current head or selected bake)
- Slot metadata still records which member sits where for rebake and labels

## Two compose kinds

Same workstream object; different layout recipes and promote targets.

### 1. Plate / scene composite

Merge a few stills into one production frame the model can continue from.

Example:

1. Owl left, human right, with space between them on a 1:1 canvas
2. AI image-edit fills the gap and cleans bars/seams
3. More Replicate edits, all local
4. Come back later, reopen the stream, branch from an earlier candidate if needed
5. Pick the good still as a first/last frame — without treating every intermediate as “the” asset

Recipe focus: slot order, L/R (or simple grids), aspect, resolution, gap/gutter, margins. Often followed by AI cleanup so the plate reads as one image.

### 2. Reference sheet

Assemble many related stills into one labeled sheet for continuity and model reference—character sheets, environment/set sheets, prop details.

Examples: character turnaround + expressions + detail callouts; workshop wide + angles + panel closeups with captions.

Recipe focus:

- Multi-row grids with uneven cell counts (e.g. 3 on top, 4 in middle, 2 on bottom)
- Variable row heights and nested cells (one column split into stacked closeups)
- Sheet title and per-cell labels/captions
- Gutters, background, output resolution large enough for reference use
- Usually keep panel boundaries (not gap-fill into one seamless plate)—the sheet *is* the product

Promote target: attach as character/environment reference, include in Seedance-style reference packages, or keep as a reusable project still. May still use the workstream to tweak layout, swap cells, or AI-clean a cell before rebaking the sheet.

## User loop

Plate (the thin slice — Phases A–B):

- [ ] Select images → Composite → recipe → **Create composition** (Assets card)
- [ ] Open composition → update plate (internal step) → AI-edit head → iterate
- [ ] **Add selected to Assets** when a step should stand alone; discard interim inside

Sheet (Phase D):

- [ ] Select images → Composite → sheet recipe (grid, labels, title, resolution)
- [ ] Create / open composition → bake sheet as internal node
- [ ] Adjust layout / swap cells / optional AI cleanup → iterate
- [ ] Promote node as character/environment/reference package input; discard interim

Shared (Phase C):

- [ ] Reopen composition later from Assets; browse history; continue from the selected node or duplicate from an earlier one

## Phases

Ordering bias: bound folder first (everything lands somewhere sane from day one), then the thinnest plate → edit → discard loop end to end, then reopen/visibility polish, then sheets, then promote targets. Model quality is already validated by hand — the edit models get there in a few tries, so the loop must make “a few tries then delete the interim” cheap.

### A. Bind a folder to the project (output landing)

The foundation everything else lands on.

- [x] Project setting: one bound Library folder = default landing zone for new local outputs
- [x] `importLocalPaths` (or a wrapper) can file imports into a target folder
- [x] Retrofit the existing Replicate timeline-fill path so its outputs land in the bound folder
- [x] Attach stays as-is: include existing folders without making them the landing zone
- Done when: new generated outputs file into the bound folder instead of appearing as loose top-level assets

### B. Thin slice: create composition + internal plate/edit + promote

Wire Selection Composite, plate only. Sheets come later (Phase D).

- [x] Plate recipe: ordered picks; side-by-side L/R; aspect, resolution, fit/fill, gap/gutter, margins
- [x] **Create composition** → Assets composition card (record + sandbox); no plate promoted yet
- [x] Update plate / AI edit → internal nodes (Library files, `showOutside: false`); not top-level Assets
- [x] Direct Replicate + local import — not Lab’s Parascene path; no intermediates in Parascene Images groups
- [x] Linear history v1 (no DAG): each node = local creation id + parent + prompt/model/settings
- [x] Mark a node selected; **Add selected to Assets** sets `showOutside` and lands in bound folder / project
- [x] Discard interim: delete non-selected nodes (local file + catalog row); provenance kept
- Done when: select → Create composition → Assets card → reopen → update plate + AI edits stay inside → promote one step out

### C. Workstream reopen + visibility

Polish the object created in B; deepen folder-like behavior.

- [x] Workstream record: identity, title, compose kind, layout recipe, member asset ids, linear nodes, selected node
- [ ] Recipe slots: stable id, label, member creation id, layout rect
- [x] Reopen in preview pane from Assets composition card
- [ ] Branch = duplicate workstream from a chosen node (full in-place branching DAG deferred)
- [x] Per-node `showOutside` (bakes). Default: internal until promote. Pop out = promote
- [x] Asset browser: composition entry; hide non-promoted composition creations at root
- Done when: composition tidies the assets list, promote reveals a usable still, reopening shows members and bake history where you left off

### D. Reference sheets

Second compose kind, after the loop is proven on plates.

- [ ] Sheet recipes: multi-row grid templates; uneven columns; nested/stacked cells; sheet title; per-cell labels
- [ ] Small template set first (character 3+4+2, set wide+3, etc.); freeform later
- [ ] Rebake sheet from updated sources when layout or a cell changes; optional whole-sheet or cell-level AI cleanup via the same edit loop
- Done when: selected stills + labels → one reference-sheet still as a workstream node, iterable like a plate

### E. Promote targets

- [ ] Plate promote: first/last frame / generate-from-selection / later ShotSpec
- [ ] Sheet promote: character/environment reference / reference-package assembly (backlog #8–#10)
- [ ] Thin provenance/lifecycle on nodes (`candidate` / `selected` / `discarded`); full catalog purpose columns can wait for backlog #2
- Done when: experimentation leaves a usable selected still plus clean lineage, not an undifferentiated pile

## Decisions

- Bound folder ships first; it is the project’s file container (one per project), not an attached folder card; members show flat in Assets; bind/clear locked while timeline uses those files
- Edit-model quality already validated by hand — no spike phase; the loop optimizes for “a few tries, then delete the interim”
- Linear history for v1; branch = duplicate workstream from a node; in-place branching DAG deferred
- Discard deletes interim files and catalog rows but keeps the node record (prompt/model/settings) with `discarded` state; sources and the selected bake are never deleted by discard
- Show-outside default: members hidden at top level, selected bake visible
- Sheets come after the plate edit loop is proven (Phase D), not alongside it
- A composition is optionally folder-like (group members, clean assets list) and optionally generative (bake new assets)
- Show-outside is per image; pop out = reveal an existing member/bake at top level; bake = create a new asset
- Local layout first for Composite v1 (guarantees placement); gap-for-AI-fill is a first-class plate recipe option
- Reference sheets are a first-class compose kind—same composition object, different recipe
- Address members via slots/ids; address bakes as their own assets—do not crop individuals out of a bake
- Sheet v1 can ship with a small set of templates (character 3+4+2, set wide+3, etc.) before freeform grid editing
- Aspect and resolution are recipe parameters, not hardcoded forever
- All gen/edit outputs stay local-only until deliberate publish
- Promoting picks a member or a bake; it does not require landing on the timeline

## Folders: attach vs bind (output landing)

Today a project can **attach** Library folders (`folderIds`): members are pulled into the project asset list and the folder appears as a card you can open. That does not make the folder the project container.

Two different relationships:

1. **Attach folder** — “include these existing assets in the project.” The folder shows as a card in Assets; members stay nested under it. Only available when the project has **no** bound folder.
2. **Bind folder** — “this folder **is** the project’s file container.” One per project. Assets shows the folder’s members **flat** — no folder card for the bound folder. New local outputs land in that folder. Add files to the project by moving them into the bound folder. While bound: no attach/bind of other folders (folders cannot nest); the only folder action is **Unbind** (blocked while any of those members are used on the timeline).

Without bind, a bake only becomes another loose project asset.

Bind is **Phase A**. Scope:

- Exactly one bound working folder per project (not attach, not multi-bind)
- Bound folder never appears as an Assets folder card; members are the project file list
- Once bound: Library offers Unbind (when that folder is selected) and Add to working folder for selected files — not Add folder to project
- Composition bake/edit outputs file into the bound folder and appear as project assets
- Attach remains available only before a working folder is bound
- Same landing rule for video as for stills

Composition vs Library folder: a composition is folder-like for its members/bakes and carries a recipe + stream. A Library folder is the broader container. Bind answers “what is this project’s working file pool?”; composition answers “how do these stills relate and bake?”

## Touch points

- `src/layouts/editor/previewIntent.ts` — Composite mode; still method wiring
- `src/layouts/editor/SelectionIntentPanel.tsx` — Composite UI / recipe controls (plate vs sheet)
- `src/layouts/editor/PreviewPane.tsx` — reopen workstream in preview
- `src/layouts/editor/addAssetReplicateGenerate.ts` — direct Replicate + local import pattern
- `src-tauri/src/library/slideshow.rs` — analogous local bake reference
- `src/library/catalogClient.ts` — `importLocalPaths`
- `src/project/desktopAddAssetGeneration.ts` — provenance stamp pattern
- Project store / types — where the workstream object lives
- Later: character/environment entities and reference-package assembly

## Later / not v1

- Full freeform canvas / arbitrary sheet designer
- AI-first merge with no layout recipe
- Video composites
- Full ShotSpec / chat tools
- Parascene publishing of intermediates
- Multi-workstream merge UI
- Auto-generating sheet layouts from character/environment entity fields
