# Plan — Library and sync

Derived from the ~3:33 design in [ChatGPT share](https://chatgpt.com/share/6a56996c-fb70-83ea-a3c0-1bb8b4468f30). Orientation: [PLAN-from-chatgpt.md](./PLAN-from-chatgpt.md). Source wireframe: [mockups/library-wireframe.png](./mockups/library-wireframe.png). Mode mocks for when a project is open: [mockups/](./mockups/).

**UI caveat:** Library information architecture from the chat is the guide; visual chrome should stay consistent with the shipped shell and be customized rather than copied from the mockups when they diverge ([mockups/README.md](./mockups/README.md)).

**Architecture:** Local Library/SQLite is also how desktop **eases load on Parascene web/DB** — not everything belongs in the cloud. See [PLAN-architecture-principles.md](./PLAN-architecture-principles.md).

## Product model

Two conceptual levels:

1. **Library** — everything the user owns locally or on Parascene
2. **Project workspace** — Director / Editor / Hook for a selected project

Editing modes appear only when a project is open. Clicking **Parascene** (or the brand breadcrumb) returns to Library.

### Navigation

Preferred hierarchy:

```text
Parascene  /  {Project name}          [Director] [Editor] [Hook]
```

- Modes only visible with an open project
- Do not put Library inside Director
- Avoid arbitrary docking / floating workspace designer

### Library screen (target)

- Sidebar: All Assets, Videos, Images, Audio, Published, Unpublished, Expiring Soon, Projects, Downloads
- Main: asset grid (thumbnails + names)
- Header: sync status (e.g. “Syncing 14 of 387”) + user
- Footer: counts (local / downloading / last synchronized)

Selection actions:

- Create project
- Add to existing project
- Download now
- Reveal in Finder
- View on Parascene

### How layouts consume the library

- **Editor** left panel: project-scoped catalog + “All Library”
- **Director**: only assets already in the project
- **Hook**: later; still mocked for now

## Technical architecture

Do **not** put download logic in React Library components. Persistent native service:

```text
Parascene API
    ↓ manifest
Sync service
    ├── downloads files
    ├── resumes interrupted jobs
    ├── verifies checksums
    └── updates local catalog
             ↓
          SQLite
             ↓
     Library React views
```

### Suggested modules

```text
src/
  library/
    LibraryView.tsx
    AssetGrid.tsx
    useLibrary.ts
  sync/
    syncClient.ts
    syncState.ts

src-tauri/src/
  sync/
    manifest.rs
    download.rs
    queue.rs
  library/
    catalog.rs
    paths.rs
```

### Catalog (SQLite) + files on disk

SQLite records metadata; media remains ordinary files. Suggested fields:

- Parascene creation ID
- Local path
- Remote URL / version
- Media type
- Published state
- Creation date
- Prompt and metadata
- Download state
- Checksum
- Expiration date (if applicable)

### Local storage layout

Ask once on first run; default:

```text
~/Movies/Parascene/
  Library/
  Projects/
  Exports/
  Cache/
```

- **Library** durable
- **Cache** disposable
- **Projects** reference Library assets (no duplication unless user chooses a portable project)

### Sync policy

Do not silently download everything. First-run choices:

- Download everything
- Videos only
- Recent creations
- Browse first, download on demand

After setup, “Download everything” can become continuous incremental sync.

Status near the existing connected badge:

```text
connected · syncing 14
```

Click opens queue, failures, disk usage, last sync.

**Key distinction:** Library is a first-class destination; sync is background infrastructure. Editing modes consume Library; they must not own it.

## Implementation phases

1. Interfaces / types for catalog + sync state (TS + Rust commands)
2. Paths + SQLite catalog schema (empty library UI possible)
3. On-demand download for a single creation
4. Library React view (grid, filters, selection actions stubbed where needed)
5. Bind project workspace to project-scoped assets; hide modes until a project is open
6. Manifest sync + resume + checksums; status chip + queue UI
7. First-run policy + incremental “download everything”

## Dependency: FFmpeg

Local thumbs / preview / later media work will need a usable FFmpeg. That is tracked in [PLAN-ffmpeg.md](./PLAN-ffmpeg.md) (detect + assist install). Library catalog/sync can proceed before FFmpeg is ready; gate media-processing actions on readiness.

## Dependency: Parascene generation

Creating new clips (first–last frame, short duration, prompt relay) depends on platform generation support — [PLAN-parascene-generation.md](./PLAN-parascene-generation.md). Library still syncs *existing* creations regardless.

## Out of scope for this plan

- Real timeline / render / Hook publish
- Apple codesign / notarization / auto-update
- Changing OAuth (keep loopback + Keychain)
