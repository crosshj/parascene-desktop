# Guide — Architecture principles (desktop vs cloud)

**Also see:** [PLAN-backend-ownership.md](./PLAN-backend-ownership.md) — Rust vs React boundary, what still lives in the FE that should move behind the jobs/workers model.

## Soften load on Parascene web / DB

**Settled:** Parascene Desktop is designed to **ease the load on the Parascene web app**, especially the **database**. Prefer work that stays on the user’s machine (catalog, file storage, sync queue, FFmpeg thumbs/preview, project state) over patterns that continually hit Parascene for reads/writes the desktop can own locally.

Implications:

- Local SQLite + file library is not just UX; it is a **scalability / cost** strategy
- Sync should be incremental and resumable — avoid N+1 or “reload everything” against Parascene
- Project editing state and assistant draft context should default to **local** until something truly needs to be shared or published
- Do not mirror every browser session concern into extra cloud rows “because desktop”

## Not everything in the cloud

**Settled direction:** We do **not** assume every asset, intermediate, or edit must live in Parascene cloud storage/DB. Durable local Library / Projects / Exports / Cache ([PLAN-library-sync.md](./PLAN-library-sync.md)) is first-class. Cloud remains the source for Parascene-owned creations the user chooses to sync, account identity, and product features that require the platform.

## Generations without Parascene “creations”

**Clarified meaning of “provider”:** Get generations **straight from the generation server that Parascene already uses** (Parascene Blue), and **do not** persist that output as a **Creation** row (or equivalent) in the Parascene database.

This is **not** only “desktop talks to third-party APIs.” Replicate direct already lands local-only. **Parascene Blue direct** is the first-party counterpart: user Blue credentials → Blue HTTP (incl. `/api/files`) → local library import.

**Lab is the first ship surface for method exploration:** Desktop Lab’s **Parascene Blue methods** + unified **Predictions** (Replicate + Blue) remain the capabilities explorer. **Generate** is intent-first (modality → server); **Direct to Blue** is the Generate server for Blue-direct (Settings creds → Blue API → local-only import). Editor **Parascene** server gens via `server_id: 6` stay Creation-backed and must not be labeled “Blue.”

**Settled for Blue-direct:** Blue-direct jobs (Lab + Generate Direct to Blue) must not create Parascene Creations. The existing **Parascene** product path (credits / `server_id: 6` / Creation ingest) remains for web migrants and stays Creation-backed.

**Still open:**

- Whether/when the user can “promote” a local Blue-direct gen into a real Parascene creation
- How Library sync treats files that never had a Parascene creation ID
- What the web app shows (or does not show) for those jobs
- Long-term Blue auth model (token vs session vs OAuth)

## Generation provenance (Parascene vs local-only)

**Settled — catalog:** For **Parascene Creation-backed** gens, Parascene `meta.method` / `meta.args` (snapshotted into local `remoteJson` by sync) is the source of truth. A Creation generated inside a desktop project must leave the catalog looking the same as one that only arrived through sync — **do not** post-mutate `remoteJson` with a desktop stamp after generate. Result | Form derives from that meta.

**Settled — inputs:** Parascene cannot read local files; durable I2V/I2I frames must be Creations. Direct to Blue / Replicate may use local extracts, and must store **Parascene-like** provenance locally. See [GUIDE-generation-inputs-provenance.md](./GUIDE-generation-inputs-provenance.md) (guardrails) and [PLAN-generation-provenance.md](./PLAN-generation-provenance.md).

**Local-only** gens (Direct to Blue, Replicate direct) have no Creation meta; they stamp `meta.desktop.addAssetGeneration`, and sync preserves it.

## Summary

| Idea | Status |
| --- | --- |
| Desktop reduces web/DB load via local catalog, files, and offline-capable work | **Yes — design goal** |
| Not everything must be stored in Parascene cloud / DB | **Yes** |
| Parascene Blue direct gens without a Creation row (local import) | **Yes — Lab + Generate Direct to Blue** |
| Parascene Creation meta is provenance for Creation-backed gens (no post-gen catalog stamp) | **Yes** |
| Promote local gens → Parascene Creations | **Open** |
