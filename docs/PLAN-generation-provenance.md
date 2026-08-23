# Plan — Generation provenance

**Status:** Principles settled; Parascene meta derive shipped; **Parascene frame-input identity shipped**  
**Date:** August 2026  
**Related:** [GUIDE-generation-inputs-provenance.md](./GUIDE-generation-inputs-provenance.md) (**read first**), [PLAN-parascene-generation.md](./PLAN-parascene-generation.md), [PLAN-timeline-fill.md](./PLAN-timeline-fill.md), [PLAN-library-sync.md](./PLAN-library-sync.md), [GUIDE-architecture-principles.md](./GUIDE-architecture-principles.md)

---

## Principle A — Catalog shape (Creation-backed)

**A synced Parascene cloud asset must look exactly like an asset generated inside a desktop project via Parascene.**

1. Parascene Creation `meta.method` / `meta.args` (sync → `remoteJson`) is the source of truth.
2. Do **not** rewrite the catalog row after Parascene generate with `meta.desktop.addAssetGeneration`.
3. UI uses `resolveAddAssetGenerationFromCreation` → stamp (local-only) **or** derive from Parascene meta.
4. Timeline clip `addAssetGeneration` may hold rich editor continuity; that is project state, not a catalog mutation.

```
Parascene generate → Creation.meta {method, args, …}
        ↓
ingest / mapRemoteCreation → catalog.remoteJson  (stop here)
        ↓
UI: resolve(stamp? for local-only : derive(meta.args))
```

## Principle B — Input identity (by server)

**What the model saw is what Form must show.** Full rules: [GUIDE-generation-inputs-provenance.md](./GUIDE-generation-inputs-provenance.md).

| Server | Durable FIRST/LAST | Temp local extract |
|--------|--------------------|--------------------|
| `parascene_blue` | Parascene still **Creation** | Upload bridge only — not Form identity, not long-term project member |
| `blue_direct` / `replicate` | Local catalog still | **Is** the durable input; keep it; stamp Parascene-like args on the **output** |

**Known flaw:** Parascene I2V Form can still show FIRST as `local-…` after the still was uploaded as a Creation. Fix is identity rewrite on success + stop filing throwaway locals — not another desktop stamp on the video Creation.

---

## Shipped

| Piece | Behavior |
|-------|----------|
| `deriveAddAssetGenerationFromParasceneMeta` | Form state from Parascene `meta.args` / `method` |
| `resolveAddAssetGenerationFromCreation` | Stamp if present, else derive |
| `shouldStampCatalogAddAssetGeneration` | `false` for `parascene_blue`; `true` for `blue_direct` / `replicate` |
| Timeline Generate catalog stamp | Only when local-only server |
| Library Parascene T2I/I2I | No catalog stamp after success |
| Sync `preserveDesktopAddAssetGeneration` | Preserves local-only stamps; does not invent them |
| Cursor rule | `.cursor/rules/generation-inputs-provenance.mdc` |

---

## Remaining work

### P0 — Parascene frame identity on Form / project ✅

- After `prepareParasceneGenerationStill` / `uploadFramedStill`, stamp timeline + Form `startFrameAssetId` / frame sources to the **still Creation id**.
- Parascene success path never calls `ensureDurableFrameSource` (no `local-*` import) and does not merge still Creation ids into flat `project.creationIds` (group membership only).
- Bridge `local-*` extracts are removed from the project on Parascene success.
- Read heal: clear `local-*` FIRST when `input_images` URL exists; Form shows stamped URL / matched Creation id.
- Local-only (`blue_direct` / `replicate`) unchanged: still import local stills as durable members.

### P1 — Local-only Parascene-like provenance blob

Blue Direct / Replicate outputs should carry method/args-equivalent under `meta.desktop` (inputs as local ids), so one reader path serves Creation-backed and local-only rows.

### P2 — Parascene / synced indicator (not Suno/YouTube)

Separate affordance for Creation-backed vs local-only vs third-party import.

### P3 — Sync / ingest edges

Rust `ingest_remote_creation_json` vs FE preserve; Lab Creation paths must ingest-and-stop.

---

## Anti-patterns

- Stamping every Parascene completion “so Form works”
- Showing `local-*` as FIRST after Parascene already consumed a Creation URL
- Filing temp extracts into the project on the Parascene path “for convenience”
- Assuming Blue/Replicate frame handling applies to Parascene (or the reverse)
- Treating Suno/YouTube cloud chrome as Parascene sync
