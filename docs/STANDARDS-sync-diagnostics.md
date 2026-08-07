# Standards — Sync / folder failure diagnostics

When Sync (or any folder mutate path) fails, **do not leave only a one-line red banner**. Agents and humans must be able to triage from an **on-disk** trace (and optionally the console) in under a minute.

## Required behavior

1. **On-disk JSONL trace** under the Library root:
   - Path: `~/Movies/Parascene/Library/logs/folder-sync.jsonl` (or `{libraryRoot}/logs/folder-sync.jsonl`)
   - Each failure / heal event is one JSON object (phase, message, revision, pending ops, upload batch, hint).
   - Implementation: `library_append_diag_log` + `logFolderSyncFailure` in `src/sync/folderSyncDiagnostics.ts`.
2. **Console mirror** prefixed with `[folder-sync]` (nice for live DevTools; disk is the durable source for agents).
3. **UI message appendix** with a pending-ops headline when ops remain.
4. **SQLite** remains the ops source of truth: `folder_pending_ops` in `catalog.sqlite`.

## Agent triage (do this first)

When the user reports a Sync folders failure:

1. Read **`Library/logs/folder-sync.jsonl`** (last lines) — do not invent theories before this.
2. Optionally check Sync banner / `[folder-sync]` console.
3. If needed: `SELECT seq, created_at, op_json FROM folder_pending_ops ORDER BY seq;`
4. Match against **Known errors** below.

## Known errors

| Message (or substring) | Likely meaning | First check |
| --- | --- | --- |
| `project folder marker cannot be changed` | Folder API **forbids** clearing `meta.parascene_desktop.project_id` via `update` (even with `project_id`). Release must be ownership-asserted **delete** + **create** regular (same id/members). Sync rewrites stuck empty-meta clears to that pair. | Disk trace; pending should become `delete`+`create`, not `update` meta clear. |
| `project folder is locked on this client` | Mutate without ownership assertion, or user-edit lock on a marked folder with no local project doc. | Disk trace pending list. Not a filesystem lock. |
| `Dropped N unowned project-marker clear(s)` | Heal: Sync discarded foreign marker clears and restored cloud project folders as browse-only. | Expected after mistaken auto-liberate. |
| `base_revision is stale` / folder conflicts UI | Cloud revision moved; need conflict resolution or retry after pull. | Sync conflict cards. |
| `Library folders are not available` / 501 | Folders API unavailable. | Auth + API host. |
| `Some folder changes are still pending` | Upload loop exited with ops left. | Disk trace + `folder_pending_ops`. |

## Lock meaning (product)

**“Locked on this client” is not an OS/filesystem lock.** It means: this device does not have the project document for a cloud project-marked folder, so **user edits** (rename / refile / delete members / clear marker) are blocked. Browse/download may continue. Cloud snapshots from the owning machine stay authoritative. This client must **not** auto-take over another device’s project folders.

Safe marker clears:

- **Delete project** on a machine that owns the document → convert + ownership-asserted clear (`project_id` set) + Sync.
- **Explicit “Release as regular folder”** (user chose) → same.

Unsafe (removed):

- Auto-liberate every `kind=project` folder with no local usage revision on Sync.

## Marker release contract

- Clearing `meta.parascene_desktop.project_id` via `update` is **not supported** (API: `project folder marker cannot be changed`).
- Release / Delete project: ownership-asserted `{ op: "delete", id, project_id }` then `{ op: "create", id, title, description, creation_ids, meta: {} }`.
- Stuck empty-meta clears **with** `project_id` are rewritten to that delete+create pair on Sync.
- Empty-meta clears **without** `project_id` are dropped (foreign/unowned).
- Delete project / manual Release sync immediately after convert.

## When changing sync / liberate / project-folder code

- Keep disk JSONL traces on new failure/heal paths.
- Add a **Known errors** row for new user-visible sync strings.
- Do not reintroduce Sync auto-liberate of foreign project folders.
- Do not invent `project_id` from cloud onto unowned clears just to force a successful mutate.
