# Guide — Backend ownership (Rust vs frontend)

**Status:** Direction settled. Catalog sync, generation, and most jobs already go through `service_invoke`. Folder reconcile is the main leftover.  
**Related:** [GUIDE-architecture-principles.md](./GUIDE-architecture-principles.md), [GUIDE-generate-wait.md](./GUIDE-generate-wait.md), [GUIDE-service-and-forms.md](./GUIDE-service-and-forms.md)

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

This matches how **downloads**, **generation jobs**, and **catalog sync** already work.

## Hard rules

1. **All Parascene work is `service_invoke`.** Create → wait → group → delete → catalog sync → folder reconcile → cloud repair belong in Rust. FE collects values, invokes, watches a handle, paints. A React-owned loop is leftover to migrate, not a pattern to copy.
2. **FE tracks UUIDs / status, not recipes.** Enqueue work, `listen` for events, paint. Safety-net poll is OK; owning the loop is not.
3. **One mapper for remote → catalog.** Rust `map_remote_creation_json` is the authority; FE must not diverge with a second “almost the same” mapper for production ingest (FE may keep thin display helpers).
4. **Secrets and product state leave `localStorage`.** Tokens/keys → Keychain (or Rust secure store). Projects → `user.sqlite` `project_documents` (account bundle).
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

Disk layout (settled — per account after isolation):

```text
~/Movies/Parascene/          # or Videos/Parascene on Windows
  accounts.json
  session.sqlite             # debug auth KV + OAuth
  users/<slug>/
    Library/catalog.sqlite   # creations, folders, jobs, sync_meta, …
    Library/media/
    Library/thumbs/
    user.sqlite              # project_documents, settings secrets
    Projects/
    Exports/
    Cache/
```

## What Rust already owns (keep / extend)

| Domain | Module(s) | Notes |
| --- | --- | --- |
| Auth tokens / refresh | `auth_store.rs` | Keychain (release); machine `session.sqlite` (debug) — never the library catalog |
| OAuth loopback | `oauth_listener.rs` | FE owns browser UX only |
| Catalog SQLite | `catalog.rs` | Source of truth for Library rows |
| Thumb / media download | `download.rs` | Prefer fit thumb → square → full |
| Generation jobs | `jobs.rs` + `parascene_api.rs` | `ensure_project_groups`, `create_media`, `wait_creation`, … |
| Folders local DB | `folders.rs` | Pending ops table exists; reconcile still FE |
| Import / FFmpeg derived | `import_local`, `merge`, `reverse`, `slideshow`, `beats`, `lab_audio`, `thumb_fill` | Correct |
| Publisher render | `render.rs` | Correct; FE schedules only |
| `media://` streaming | `media_stream.rs` | Correct |

## What FE still orchestrates (migrate)

Do not add another React protocol. Pull these behind `service_invoke` the same way generate and newest sync already work.

- `src/sync/folderSync.ts` — revision fetch, conflict, mutate, ack. Target: Rust folder reconcile; FE shows conflicts / choices.
- Dual mapper risk if any production ingest still uses an FE `mapRemoteCreation` instead of Rust `map_remote_creation_json`.
- Optional: shrink `src/sdk/parascene.ts` to rare one-shots; OpenAI calls can stay FE while the key is in the secure store.

UI prefs (sidebar width, editor pane sizes, shell tab) may stay in `localStorage`. Durable job identity stays in `jobs`.

## What correctly stays FE

- Shell chrome, Library grid/lightbox/filters, Editor staging/timeline UI, Director UI, Publisher UI
- Settings / confirm dialogs / capability stubs
- “User clicked Sync / Ensure / Render” → enqueue
- Rendering `jobs-updated` / `library-*` / publisher progress into banners and badges
- Prompt copy / form values passed **into** job payloads (prompts are data, not orchestration)

## How to extend

1. **Reuse `jobs` + events.** Do not invent a second queue.
2. **FE becomes thinner, not cleverer.** Delete orchestration; keep `*Client.ts` façades.
3. **Mapper once.** New remote→catalog paths call Rust ingest.
4. **Resume = job UUID.** Leaving a screen must not abort backend work; remount re-attaches.
5. New Parascene multi-step work is a Rust job, not a React loop.

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

The debt left is **folder reconcile** (and any stray FE ingest mapper). Pull those behind the same queue/event model.
