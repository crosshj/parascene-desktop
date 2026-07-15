# Plan — Library and sync

Derived from the ~3:33 design in [ChatGPT share](https://chatgpt.com/share/6a56996c-fb70-83ea-a3c0-1bb8b4468f30). Orientation: [PLAN-from-chatgpt.md](./PLAN-from-chatgpt.md). Source wireframe: [mockups/library-wireframe.png](./mockups/library-wireframe.png). Mode mocks for when a project is open: [mockups/](./mockups/).

**UI caveat:** Library information architecture from the chat is the guide; visual chrome should stay consistent with the shipped shell and be customized rather than copied from the mockups when they diverge ([mockups/README.md](./mockups/README.md)).

**Architecture:** Local Library/SQLite is also how desktop **eases load on Parascene web/DB** — not everything belongs in the cloud. See [PLAN-architecture-principles.md](./PLAN-architecture-principles.md).

## Product model

**Chrome (settled — supersedes ChatGPT breadcrumb / Library-as-sole-home IA):**

```text
| Library | Project |          | {context tabs} |
```

Context tabs (same header row, after spacer) depend on the primary tab:

- **Library** → `Creations | Sync`
- **Project** + open project → `Director | Editor | Hook`
- **Project** + no project → picker only (no context tabs)

1. **Library** (default on open) — browse/download Parascene creations **without** an open project. Sync UI is a header context tab (sync logic stays native).
2. **Project** — if nothing open: VS Code–style picker (recent + New project). If a project is loaded and this tab is selected: workspace body + mode context tabs.
3. Switching to Library hides mode tabs but keeps the project loaded; Close project returns to the picker.

Do not treat Library as a DAM-only home with Projects buried in a sidebar. Do not put Library inside Director. Avoid arbitrary docking / floating workspace designer.

### Library screen (target)

- Creations: asset grid (thumbnails + names); filters as needed later (type, published, expiring, etc.)
- Sync: queue, failures, disk usage, last sync
- Selection actions (later): Download now, Reveal in Finder, View on Parascene, Add to project / New project from selection

### How layouts consume the library

- **Editor** left panel: project-scoped catalog + path into Creations
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

**Key distinction:** Library is a primary chrome tab (peer to Project); sync is background infrastructure with a Library → Sync surface. Editing modes consume the catalog; they must not own downloads.

## Implementation phases

1. ~~Library \| Project chrome + Project picker + stub Creations/Sync~~ (shell done)
2. ~~Interfaces / types for catalog + sync state (TS + Rust commands)~~
3. ~~Paths + SQLite catalog schema (`~/Movies/Parascene`, `catalog.sqlite`)~~
4. ~~Creations grid + Sync status panel wired to catalog~~
5. ~~Manifest sync: `GET /api/create/images` → SQLite~~
6. ~~Download media + thumbs into `Library/media` and `Library/thumbs` (masonry Creations grid)~~
7. Library Creations UI polish (filters, selection actions)
8. Bind project workspace to project-scoped assets
9. Resume interrupted downloads + checksums; richer Sync queue UI
10. First-run policy choices (videos only / recent / on-demand)

## Dependency: FFmpeg

Local thumbs / preview / later media work will need a usable FFmpeg. That is tracked in [PLAN-ffmpeg.md](./PLAN-ffmpeg.md) (detect + assist install). Library catalog/sync can proceed before FFmpeg is ready; gate media-processing actions on readiness.

## Dependency: Parascene generation

Creating new clips (first–last frame, short duration, prompt relay) depends on platform generation support — [PLAN-parascene-generation.md](./PLAN-parascene-generation.md). Library still syncs *existing* creations regardless.

## Out of scope for this plan

- Real timeline / render / Hook publish
- Apple codesign / notarization / auto-update
- Changing OAuth (keep loopback + Keychain)
