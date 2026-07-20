# Plan — Backend ownership (Rust vs frontend)

**Status:** Direction settled; migration incremental  
**Related:** [PLAN-architecture-principles.md](./PLAN-architecture-principles.md), [PLAN-library-sync.md](./PLAN-library-sync.md), [PLAN-parascene-generation.md](./PLAN-parascene-generation.md), [PLAN-song-to-video.md](./PLAN-song-to-video.md)

## Goal

Parascene Desktop is a **local-first Tauri app**. Rust owns durable state, Parascene protocols, and long-running work. The React frontend owns UI, user intent, and rendering of backend status — **not** multi-step create/wait/sync/group loops.

Wrong model (what we drifted into):

```text
React ──orchestrates──► Parascene API
  └── occasionally dumps results into SQLite
```

Target model:

```text
React ──enqueue / listen──► Rust worker / jobs
                              ├── Parascene API
                              ├── catalog.sqlite + files
                              └── emit progress / result events
```

This matches how **downloads** and **generation jobs** already work, and how **catalog sync** should work.

## Hard rules

1. **No Parascene multi-step protocols in React.** Create → wait → group → delete → catalog sync → folder reconcile → cloud repair belong in Rust (commands and/or the `jobs` queue).
2. **FE tracks UUIDs / status, not recipes.** Enqueue work, `listen` for events, paint. Safety-net poll is OK; owning the loop is not.
3. **One mapper for remote → catalog.** Rust `map_remote_creation_json` is the authority; FE must not diverge with a second “almost the same” mapper for production ingest (FE may keep thin display helpers).
4. **Secrets and product state leave `localStorage`.** Tokens/keys → Keychain (or Rust secure store). Projects → disk / SQLite under `~/Movies/Parascene/Projects/`.
5. **Pure UI stays FE.** Grids, panes, selection, prefs chrome, confirm dialogs — no need to move.
6. **Prefer generic primitives over Lab-named APIs.** Job kinds like `create_media` / `wait_creation` / `sync_catalog` — not `lab_*`. Surfaces (Lab, Director, Editor) compose them.

## Established patterns to copy

| Pattern | Where | Use for |
| --- | --- | --- |
| Download / ensure worker | `src-tauri/src/library/download.rs` | Any “warm local files” work |
| SQLite jobs + Tokio worker | `src-tauri/src/library/jobs.rs` | Durable Parascene / generation workflows |
| Rust Parascene client | `src-tauri/src/library/parascene_api.rs` | Auth’d HTTP from workers (not WebView) |
| Catalog + ingest | `src-tauri/src/library/catalog.rs` | Persist creations; `map_remote_creation_json` |
| Events | `jobs-updated`, `library-*`, `publisher-*` | FE progress / refresh |
| Thin FE clients | `src/jobs/jobsClient.ts`, `catalogClient.ts` | Invoke + listen only |

Disk layout (settled):

```text
~/Movies/Parascene/
  Library/catalog.sqlite   # creations, folders, jobs, sync_meta, …
  Library/media/
  Library/thumbs/
  Projects/                # target for project JSON (today: FE localStorage)
  Exports/
  Cache/
```

## What Rust already owns (keep / extend)

| Domain | Module(s) | Notes |
| --- | --- | --- |
| Auth tokens / refresh | `auth_store.rs` | Keychain (release); catalog KV (debug) |
| OAuth loopback | `oauth_listener.rs` | FE owns browser UX only |
| Catalog SQLite | `catalog.rs` | Source of truth for Library rows |
| Thumb / media download | `download.rs` | Prefer fit thumb → square → full |
| Generation jobs | `jobs.rs` + `parascene_api.rs` | `ensure_project_groups`, `create_media`, `wait_creation`, … |
| Folders local DB | `folders.rs` | Pending ops table exists; reconcile still FE |
| Import / FFmpeg derived | `import_local`, `merge`, `reverse`, `slideshow`, `beats`, `lab_audio`, `thumb_fill` | Correct |
| Publisher render | `render.rs` | Correct; FE schedules only |
| `media://` streaming | `media_stream.rs` | Correct |

## What FE still orchestrates (should move to Rust)

Priority roughly: **sync first** (everyone hits it), then **finish generation**, then **persistence / secrets**.

### P0 — Catalog & sync

| Today (FE) | Target (Rust) |
| --- | --- |
| `src/sync/manifestSync.ts` — page Parascene, map, apply, prune, kick downloads | `jobs` kind `sync_catalog` / `sync_newest` (+ optional full sync): fetch → `map_remote_creation_json` → upsert → enqueue thumbs/media → emit progress |
| `src/sync/folderSync.ts` — revision fetch, conflict, mutate, ack | Rust folder reconcile worker or job; FE shows conflicts / choices |
| `src/sync/cloudRepair.ts` — repair batches + local fit plan | Rust job(s); FE triggers + shows status |
| Dual mapper risk (`manifestSync.mapRemoteCreation` vs Rust ingest) | **Single** Rust mapper; FE sync path deleted or reduced to `jobs_enqueue` |

Triggered from Library Sync UI (`LibraryView.tsx`) via enqueue + listen — not by running the recipe in React.

### P0 — Generation / Lab leftovers

| Today (FE) | Target (Rust) |
| --- | --- |
| Lab create / mutate / a2v / seeds `create` + `waitForCreation` in `LabLayout.tsx` | Compose `create_media` / `wait_creation` / `group_creations` jobs (already exist) |
| `fileCreationIntoProjectGroup` still SDK in `projectGroups.ts` | `group_creations` job |
| Resume via Lab `localStorage` + pending creation ids | Prefer `backendJobId` on `jobs` table (groups already do this) |

**Already migrated (model to copy):** ensure / cleanup project groups → `jobs_enqueue` + `watchJob`.

### P1 — Durable product state

| Today | Target |
| --- | --- |
| `parascene.projects.v1` in `projectStore.ts` | Files or SQLite under `Projects/`; Rust read/write commands; FE patches via shell API |
| OpenAI key in `localStorage` (`openaiClient.ts`) | Keychain / secure Rust store |
| Lab session `labSession.v2.*` | Thin UI prefs OK; durable job identity stays in `jobs` |

UI prefs (sidebar width, editor pane sizes, shell tab) may stay in `localStorage`.

### P2 — Optional consolidation

| Item | Note |
| --- | --- |
| FE `ParasceneSdk` (`sdk/parascene.ts`) | Shrink to rare one-shots or delete as jobs cover sync/generation; avoid two HTTP stacks forever |
| Direct OpenAI from FE | Prefer Rust proxy if keys live in Keychain and calls should be auditable/offline-tolerant |
| Auth session memory cache | Fine in FE; refresh already Rust |

## What correctly stays FE

- Shell chrome, Library grid/lightbox/filters, Editor staging/timeline UI, Director UI, Hook UI
- Settings / confirm dialogs / capability stubs
- “User clicked Sync / Ensure / Render” → enqueue
- Rendering `jobs-updated` / `library-*` / publisher progress into banners and badges
- Prompt copy / form values passed **into** job payloads (prompts are data, not orchestration)

## Approach (how to migrate)

### Principles

1. **One vertical at a time.** Ship catalog `sync_newest` as a job before rewriting Lab create.
2. **Reuse `jobs` + events.** Don’t invent a second queue per feature.
3. **FE becomes thinner, not cleverer.** Delete orchestration; keep `*Client.ts` façades.
4. **Mapper once.** New remote→catalog paths call Rust ingest; stop growing `mapRemoteCreation` for production sync.
5. **Resume = job UUID.** Leaving a screen must not abort backend work; remount re-attaches.
6. **Align with local-first goals** in PLAN-architecture-principles: fewer chatty Parascene round-trips from the WebView; incremental sync from Rust.

### Suggested sequence

1. **Catalog sync → Rust job** — replace `syncNewestCreationsManifest` orchestration; Library UI listens for progress. Keep prune policy, but implement it natively.
2. **Retire FE production ingest path for sync** — same mapper as jobs (`map_remote_creation_json`).
3. **Lab create / mutate / a2v → existing job kinds** — mirror groups attach/cancel/detach behavior.
4. **Folder sync + cloud repair → Rust** — after catalog sync is stable.
5. **Projects on disk** — migrate `projectStore` off `localStorage`.
6. **Secrets** — OpenAI key out of `localStorage`.
7. **Shrink SDK** — only what UI still needs for non-job one-shots (e.g. credits display until that is a command).

### Definition of done (per vertical)

- [ ] Multi-step Parascene loop lives only in Rust
- [ ] FE starts work with an id and renders status/events
- [ ] Leave / remount / restart resumes without double-mint when checkpoint allows
- [ ] Catalog rows (thumbs, fit URL, aspect, remote_json) match sync-quality ingest
- [ ] No new Lab-specific backend commands — only generic jobs/commands

## Non-goals

- Moving layout/React rendering into Rust
- A heavy job framework (DAG engines, external brokers)
- Lab-named IPC (`lab_ensure_…`) — compose generics instead
- Requiring online Parascene for pure local FFmpeg / library browse of already-synced assets

## Summary

| Layer | Responsibility |
| --- | --- |
| **Rust** | Parascene protocols, jobs, catalog, downloads, folders reconcile, FFmpeg, secrets, project files |
| **React** | Intent, forms, layout, status from events, local UI prefs |
| **Pattern** | Enqueue → worker → SQLite/files → emit → UI |

The app is already halfway there (downloads, jobs, catalog). The debt is **FE-owned sync and remaining generation recipes**. Pull those behind the same queue/event model and the “frontend does too much” smell goes away without a rewrite.
