# Plan — Architecture principles (desktop vs cloud)

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

## Generations without Parascene “creations” (open)

**Clarified meaning of “provider”:** Get generations **straight from the generation server that Parascene already uses**, and **do not** persist that output as a **Creation** row (or equivalent) in the Parascene database.

This is **not** “desktop talks to Runway/Fal/etc. on its own.” It is “run the same generation backend, skip (or defer) writing a Parascene creation for this job,” so web/DB load stays lower and ephemeral/local-only gens are allowed.

**Unsettled:** Whether / when desktop can request this path. Do **not** implement without an explicit product + API decision. Tradeoffs later:

- Auth, billing, rate limits, safety/moderation without a Creation record
- Whether/when the user can “promote” a local gen into a real Parascene creation
- How Library sync treats files that never had a Parascene creation ID
- What the web app shows (or does not show) for those jobs

Until decided: default to normal Parascene creation-backed flows when generating via Parascene; keep “gen without DB creation” as an optional path in [PLAN-parascene-generation.md](./PLAN-parascene-generation.md).

## Summary

| Idea | Status |
| --- | --- |
| Desktop reduces web/DB load via local catalog, files, and offline-capable work | **Yes — design goal** |
| Not everything must be stored in Parascene cloud / DB | **Yes** |
| Some gens via Parascene’s generation server **without** storing a Creation in Parascene DB | **Maybe — undecided** |
