# Plan — Project-owned Library folders

## Status

Desktop implementation completed on 2026-08-06 and reviewed against the project store, native Library schema/commands, folder/cloud sync, Editor hydration, generation/import paths, compositions, closed-project Library management, and legacy binding data.

The desktop code now implements Phases 1–4 below: canonical marked folders, deterministic open-time legacy reconciliation, lifecycle repair, the strict usage index and mutation coordinator, checked deletion/removal, Library/Editor cutover, project-ID output routing, and protected snapshot merging. Legacy JSON/binding readers and native compatibility commands remain isolated for the Phase 5 observation window; the binding/attachment UI and its frontend writers are removed.

**Release status:** the production Folder API now round-trips opaque JSONB `meta` and protects folders marked with `meta.parascene_desktop.project_id`. Production smoke testing verified marker round-trip, generic rename/delete rejection, matching-project mutation, and cleanup. The desktop integration projects that synced marker into local `kind/project_id`; project documents and ownership remain local. Populated-profile and mixed-client manual preflight remain release checks.

This revision preserves the central design constraint:

```text
assets in project P = creations in P's Library folder
```

The project folder is the actual base of project assets, not a virtual collection and not a second membership layered over regular folders. Library and Editor are two views over the same folder membership. The plan addresses sharing, legacy attachments, cloud changes, closed projects, and delete protection without weakening that invariant.

**Legacy compatibility principle:** do not build a migration workflow. On open, deterministically adopt an existing valid bound folder, adopt the one regular folder that already contains every legacy project asset, or create a project folder when every asset is still at Library root. If none applies, block opening and explain the exact folder conflicts. The user fixes the filing in Library and retries.

## Goal

Every project owns exactly one actual Library folder:

- created automatically with the project;
- named exactly after the project;
- renamed automatically with the project;
- visibly marked as a Project folder;
- used as the canonical project asset set and output destination;
- manageable from Library whether or not the project is open;
- protected from independent rename/delete/rebinding;
- flat for now, because the current folder model does not support nesting.

Bind, Unbind, Change binding, Add folder to project, and Remove folder from project disappear. A project folder is an invariant, not a configurable relationship.

## Product contract

The strict invariant applies to a **ready project**:

1. Exactly one `folders` row has `kind = 'project'` and `project_id = P.id`.
2. Its title equals `P.title`.
3. Its `folder_items` members are exactly the creations owned by P. Every new timeline/composition reference created after cutover must point to one of those members, including hidden composition internals.
4. Editor Assets and Library read that same inventory. Either surface may group composition internals under a composition instead of duplicating them as loose cards, but it may not omit them from project membership.
5. No independent frontend project-asset list may override folder membership.
6. Adding/removing/moving a folder member updates the project whether P is open or closed.
7. An asset used by P's timeline or compositions cannot be removed from P's folder.
8. A creation used by any project's timeline or compositions cannot be globally deleted from Library, regardless of which project is open.
9. Project folders cannot be rebound, independently renamed/deleted, placed inside projects, or used as ordinary folder-picker targets.
10. Imports and generation route by `projectId`; native code resolves the project folder.
11. Folder/cloud sync preserves the project invariant and never silently breaks project state.
12. Legacy adoption never deletes folders, media, timelines, compositions, or project documents. Its only automatic asset move is filing an all-root legacy asset set into the newly created project folder.

“Owned asset” and “referenced creation” are intentionally distinct. Folder membership defines ownership and Editor Assets. A legacy/corrupt project may still reference a catalog creation outside its folder; that creation is not silently made an asset, but the reference remains playable, globally delete-protected, and visibly repair-needed. No post-cutover command may create a new outside reference.

### Provisioning exception

Projects are JSON in localStorage while folders are native SQLite rows. Those stores cannot share a transaction. A narrowly scoped lifecycle state is necessary:

- `provisioning`: project JSON exists; folder setup is incomplete.
- `ready`: folder/title/membership/usage have reconciled.
- `repair-needed`: setup or sync invariant needs a visible retry.

A new provisioning project cannot open in Director/Editor. A crash resumes provisioning. Before native folder creation, an incomplete project may be discarded safely; after the folder transaction commits, the only safe action is Retry/finalize until a real project-deletion/release operation exists. A legacy project becomes ready as soon as the deterministic open-time check successfully claims its folder; no separate legacy lifecycle is stored. Ready does not mean “no legacy outside references”—those are the explicit compatibility exception described above.

## Canonical data model

### Mark actual folders as project folders

Add columns to the existing `folders` table:

```sql
ALTER TABLE folders ADD COLUMN kind TEXT NOT NULL DEFAULT 'regular';
ALTER TABLE folders ADD COLUMN project_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS folders_project_id_unique
  ON folders(project_id)
  WHERE project_id IS NOT NULL;
```

Enforce in native validation/triggers:

```text
regular folder => project_id IS NULL
project folder => project_id is a non-empty project ID
```

SQLite cannot add the full table `CHECK` safely with a simple `ALTER`; use additive columns/index plus application/trigger enforcement first. A later table rebuild can add a formal `CHECK` after the schema has proven stable.

Extend the local/UI folder shape:

```ts
type LibraryFolder = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  memberIds: string[];
  memberCount: number;
  kind: "regular" | "project";
  projectId: string | null;
};
```

`kind/project_id` are a local SQLite projection, not server columns. The Folder API carries the opaque marker `meta.parascene_desktop.project_id`. Local project JSON remains authoritative for the project document. A machine with the matching project treats the folder as owned/unlocked; another machine still recognizes it as a project folder but presents it read-only.

### Folder membership is project membership

`folder_items` remains canonical. Keep the existing global uniqueness index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS folder_items_creation_unique
  ON folder_items(creation_id);
```

The target membership rules are:

- a creation has one Library folder location at most;
- a project owns the creations located in its one project folder;
- moving a creation into a project moves it out of its prior regular/project folder;
- using one source in two projects requires independently importing/creating another asset, not multi-membership;
- legacy folder adoption never duplicates assets or moves already-foldered assets; the all-root case files those unowned assets into its new project folder.

After cutover:

- listing project assets queries `folder_items` through the project's marked folder;
- adding to project inserts that project's folder membership;
- removing from project removes it from that folder;
- remote membership changes change project membership under the sync safety rules below;
- `project_assets` becomes a transitional derived cache and is ultimately removed or replaced with a SQL view.

Recommended compatibility view after old writes are gone:

```sql
CREATE VIEW project_assets_view AS
SELECT f.project_id, fi.creation_id, fi.added_at
FROM folders f
JOIN folder_items fi ON fi.folder_id = f.id
WHERE f.kind = 'project' AND f.project_id IS NOT NULL;
```

Do not retain two writable authorities (`project_assets` and `folder_items`). During rollout, every legacy `project_assets` read/write must be routed through one adapter and equality assertions must detect divergence.

This retains both constraints: each project has one folder, and each creation has at most one folder location.

### No folders inside projects—for now

The restriction remains because the project folder is the real project root and current folders contain creation IDs, not child folders. Legacy attached folders remain ordinary folders; adoption neither nests nor flattens them. Nested folders can be a later feature only after adding a real parent/child folder schema and sync protocol.

If the project folder ever stops being canonical, this restriction should be reconsidered. This plan does not take that route.

## Project usage protection

### Why a native usage index is required

Library must protect projects that are not open. Native folder/delete commands cannot currently inspect timelines or compositions because projects live in localStorage. Current checks only examine the open project and mostly timeline clips.

Add a materialized native index:

```sql
CREATE TABLE IF NOT EXISTS project_asset_usage (
  project_id TEXT NOT NULL,
  creation_id TEXT NOT NULL,
  usage_kind TEXT NOT NULL,
  usage_owner_id TEXT NOT NULL,
  usage_owner_label TEXT NOT NULL,
  document_revision TEXT NOT NULL,
  PRIMARY KEY (project_id, creation_id, usage_kind, usage_owner_id)
);

CREATE INDEX IF NOT EXISTS project_asset_usage_creation_idx
  ON project_asset_usage(creation_id);

CREATE TABLE IF NOT EXISTS project_usage_revisions (
  project_id TEXT PRIMARY KEY NOT NULL,
  document_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('stale', 'ready')),
  indexed_at TEXT
);
```

Create one exhaustive pure helper:

```ts
collectProjectAssetUsage(project: StoredProject): ProjectAssetUsage[]
```

It replaces scattered checks and covers:

- timeline clip `assetId`;
- slideshow image and audio IDs;
- `StillWorkstream.memberIds`;
- every non-discarded workstream node `creationId`, including hidden/internal nodes;
- main audio;
- storyboard/lyric source audio;
- cabinet/group ownership that would break if its creation vanished;
- future reference types through one reviewed registry/test matrix.

Internal composition nodes can stay hidden from Editor Assets, but their creations remain protected until explicitly discarded by composition logic.

Every composition node/member created or adopted by a normal post-cutover composition mutation must also be a member of the project folder. “Hidden” is presentation state, not a second ownership state. Pre-cutover outside references use the permanent diagnostic/repair rule; merely opening a legacy project must not move them implicitly.

### Revision and mutation ordering

Use three deliberately separate revisions; never compare or substitute one for another:

- `documentRevision`: an opaque token stored on each `StoredProject` and changed by every persisted project-document mutation;
- `membershipRevision`: a native monotonically increasing revision changed by folder membership transactions and used by Library/Editor events;
- cloud folder revision: the server synchronization revision used only for pull/push conflict handling.

The usage index revision for a project must equal that project's current `documentRevision` and its revision row must be `ready`. Put every project-document write, usage-index replacement, project membership mutation, and checked Library deletion behind one application mutation coordinator.

For every persisted project-document write, the coordinator:

1. takes the mutation lock and allocates the next opaque `documentRevision`;
2. calls native with the expected previous token to compare-and-set the project to the next `stale` revision **before** writing localStorage;
3. aborts the project edit if the stale barrier cannot be persisted;
4. writes the complete project JSON with the new revision;
5. replaces the project's native usage rows and flips the exact revision to `ready` in one SQLite transaction;
6. emits state only after the above result is known.

If localStorage fails after the stale barrier, rebuild the old snapshot when possible; leaving `stale` is safe and visibly retryable. Startup repair strictly loads the actual local document, resets the stale barrier to that document's token under the same exclusive lock, and rebuilds the snapshot. If usage replacement fails after localStorage succeeds, preserve the project edit and leave the native row `stale`, so every removal/delete/remote-detach fails closed until startup or an explicit retry rebuilds it.

For a checked remove/delete, the coordinator:

1. takes an exclusive project/Library mutation lock;
2. reloads all project JSON with a strict parser that cannot silently drop or default a malformed row, and rejects corrupt/unreadable rows;
3. sends each document revision and complete usage snapshot to one native command;
4. inside one SQLite transaction, replaces/validates usage rows, performs the final usage check, and applies the membership/delete mutation;
5. releases the lock only after the native result and required one-way JSON mirror update have been handled.

Project mutations wait behind that lock and must verify referenced creations still exist before committing. Native sync/removal code treats every `stale` row as protected without needing to read localStorage. This closes both races: deletion cannot slip between a project save and its usage-index update, and a project save cannot introduce a reference to a creation just deleted. If multiple app windows/processes are later supported, the coordinator/lock and project documents must move behind a native process-wide authority before enabling writes from more than one process.

### Usage update rule

Every project document mutation goes through the stale barrier and replaces that project's native usage rows with its new `documentRevision`. If the final index write fails:

- preserve the project edit;
- leave its protection index stale;
- fail closed for removal/global deletion involving that project;
- retry at startup and on demand.

Before global deletion, use the mutation coordinator above to load every stored project and perform refresh + check + delete through one native transaction. The result cannot depend on `openProjectId`. If even one stored project is corrupt or cannot be revision-validated, all global deletion is disabled because an outside reference cannot be ruled out.

## Current implementation findings

### Split project/folder persistence

- `src/project/projectStore.ts` stores projects at `parascene.projects.v1` in localStorage.
- `saveStoredProjects` catches/logs failures instead of reporting them.
- `ShellProvider.createProject` is synchronous and immediately opens.
- `ShellProvider.renameOpenProject` changes localStorage only.
- SQLite owns folders, `folder_items`, pending cloud ops, bindings, and `project_assets`.
- There is no project deletion flow; Close project only returns to picker.

### Binding/attachment state is optional and duplicated

- Projects have `folderIds` and nullable `boundFolderId`.
- `project_library_bindings` has nullable `folder_id` plus inference state.
- Editor startup copies binding between frontend/backend and reconciles asset lists.
- Attached folder cards merge members into `creationIds`.
- Library and Editor expose bind/unbind/attach/detach actions.

The existing bound-folder value is compatibility input for deterministic legacy adoption. Attached-folder state is not used to infer intent.

### Removal/delete behavior is currently unsafe for the target

- `library_remove_project_assets` calls `remove_from_folder` and then deletes `project_assets`; this happens only when a bound folder is present.
- `library_delete_project_asset` globally deletes the creation/media after checking only current-project membership.
- Library deletion checks the open timeline but not all projects or composition members.

The target needs distinct actions:

- **Remove from project**: remove/move the folder member only after target-project usage check.
- **Delete from Library**: global checked deletion only after all-project usage check.

### Cloud folder snapshots currently replace everything

`apply_snapshot` deletes/recreates all `folders` and `folder_items`, preserving only pending creates and local-only memberships. That implementation cannot remain once folders have local project identity. Snapshot application must become an ID-based merge that preserves `kind/project_id` and enforces project safety.

## Library and Editor synchronization

### One query

Both surfaces query the same marked folder membership, preferably through:

```text
library_get_project_folder(project_id)
library_list_project_asset_ids(project_id)  // derived from folder_items
```

`StoredProject.creationIds` may remain a UI compatibility mirror for one release, but never wins after cutover. Native folder membership refreshes it one-way.

### One mutation service

Expose project-ID-addressable methods, not open-project-only methods:

```ts
addAssetsToProject(projectId, creationIds, mode)
removeAssetsFromProject(projectId, creationIds)
renameProject(projectId, title)
refreshProjectAssets(projectId)
```

Library can target a closed project's folder through `folder.projectId`. Actions do not implicitly open the project.

Each successful membership transaction increments `membershipRevision` and emits an event containing project ID/revision. Shell, Editor, and Library ignore stale membership events and reload canonical folder membership. Therefore:

- Library changes update an open Editor immediately;
- Editor changes update Library even while Library is hidden;
- changes synced while a project is closed update its stored mirror and are present next open.

### Closed-project safety

Shell loads all stored project documents, not only the open project, for usage indexing and Library management. If a project's document is corrupt/unreadable or usage revision is stale:

- browsing can continue;
- removing/moving/deleting its assets fails closed;
- UI offers repair instead of guessing that the asset is unused.

Because legacy outside references are possible, an unreadable project means global Delete is disabled for every creation, not only members of that project's known folder. Project-specific folder removal remains blocked for that project. Browsing and additive filing may continue.

## Exclusive filing and cross-project reuse

Keep the existing one-creation/one-folder model. Add to project is an explicit filing action:

- unfiled creation → move into target project folder;
- creation in a regular folder → move into target project folder;
- creation already in target project → idempotent success;
- creation in another project → do not silently steal it.

For the last case, offer:

- **Move to this project**: only when source project usage proves it is not used by timeline/compositions, with explicit confirmation;
- Cancel.

If two projects genuinely need the same source, the user imports/creates a separate creation and adds that independent asset. A built-in duplicate/remap workflow is not required by this plan. New project creation uses the normal selection/Add actions.

## Folder/cloud sync rules

Project folders are real synced folders. The current singular `move { folder_id, creation_ids }` protocol and `Map<creationId, folderId>` model remain appropriate. Identity travels as opaque metadata:

```ts
type RemoteLibraryFolder = {
  // existing folder fields
  meta: {
    parascene_desktop?: { project_id?: string };
  };
};

type OwnedFolderMutation = {
  // normal create/update/delete/move operation
  project_id: string; // must match the marker
};
```

The server does not store or reconcile project documents. It preserves the marker, rejects generic mutations that touch a marked folder, and accepts an ownership assertion when `project_id` matches the marker. This is mixed-client safety within one authenticated account, not a secret authorization token.

### Metadata conflict policy

- **Project folder title:** local project title wins. Remote rename is ignored locally and queues/rebases an update back to canonical title.
- **Project folder deletion:** local project invariant wins. Preserve/recreate folder with same ID when protocol permits, requeue create/membership, and mark project repair-needed until acknowledged.
- **Description:** preserve current description unless product later makes it project-owned.
- **Regular folders:** existing sync conflict behavior remains.

### Membership conflict policy

Remote folder membership is a real project asset mutation:

- remote add/move into project folder: accept; update project membership/mirror and Library/Editor events;
- remote remove/move out of project folder, asset unused: accept; update project membership/mirror;
- remote remove/move out, asset used by timeline/composition: reject locally, restore membership, enqueue corrective move, surface sync conflict;
- remote move from project A to B, unused in A: accept as explicit transfer;
- remote move from A to B, used in A: reject/correct the move; B does not receive the creation unless the user duplicates it;
- conflicting local pending op: preserve current pending-op rebase semantics plus project protection.

All decisions use usage index for closed projects. Stale/missing usage fails closed and defers remote removal rather than risking breakage.

### Snapshot algorithm change

Replace delete/reinsert with transactional merge:

1. Load local folders, project markers, pending ops, usage revisions, and memberships.
2. Match remote folders by ID.
3. Apply existing remote truth rules to regular folders.
4. Project `meta.parascene_desktop.project_id` into local `kind/project_id`, including folders whose projects are unavailable on this device, and quarantine/reject a conflicting folder-ID/project-ID pairing instead of choosing one silently.
5. Apply project metadata/membership conflict policy.
6. Preserve local-only creation memberships; they cannot appear in cloud snapshots.
7. Rebase/generate corrective ops without duplicate operations.
8. Commit folder/membership changes and sync baseline/revision together.
9. Emit revisioned folder/project-asset updates.

Never issue `DELETE FROM folders` or `DELETE FROM folder_items` globally during snapshot application after this cutover.

### Offline behavior

Local folder/project operation succeeds transactionally and queues sync as today. A project is ready locally before cloud acknowledgement. Rename/membership changes remain pending and rebase later. “Exactly one project folder” is a local invariant; cloud convergence can be pending.

### Scope of “in sync”

- Editor Assets ↔ local Library project folder: exact and immediate.
- Local project folder ↔ cloud folders: revisioned eventual sync for cloud creation IDs.
- Local-only imports/generations: remain device-local because the current folder API filters non-numeric/local IDs.

Show local-only member count/badge and do not imply those files exist on another device. Full cross-device project parity for local-only media requires a separate upload/portable-project feature and is not silently promised by this plan.

### Server deployment gate — satisfied

The existing Folder API was extended without a versioned project protocol:

- `prsn_library_folders.meta jsonb` defaults to `{}` and is returned in every snapshot;
- create/update accept bounded object metadata;
- `meta.parascene_desktop.project_id` is immutable through generic updates;
- rename/delete and moves into or out of marked folders require a matching `project_id` assertion;
- older clients continue to read folders but their destructive generic mutations are rejected;
- duplicate titles and the existing one-folder-per-creation rule remain unchanged.

The SQL was applied before the server deployment and the production API contract was smoke-tested. No capability endpoint or `claim_project` operation is required. A one-release upload adapter converts locally queued pre-cutover `claim_project`/`kind` operations into metadata updates.

## User stories and required outcomes

### New project

#### Empty project

1. Persist project with generated ID and `provisioning`.
2. Native transaction creates marked folder named project and queues cloud create.
3. Write empty usage index.
4. Mark ready/open after native success.

Crash before/after native commit resumes idempotently. Native failure leaves a visible Retry. “Discard incomplete project” is available only when a native lookup proves that no folder, pending cloud operation, membership, or usage row was created for that ID; otherwise Retry is the sole action until the project reaches ready and a future real project-delete workflow exists. It never opens unbound and never strands a synced folder by deleting only local JSON.

#### Project from selected root assets

Create project/folder, move valid selected assets into it, write usage/mirror, then mark ready. Missing IDs return structured warning; valid project remains.

#### Project from selected regular-folder assets

Move selected assets into the new project folder as the normal New project from selection behavior. This is not a legacy migration decision; the action/copy should state that selected files become assets of the new project and leave their regular folders.

#### Project from assets in another project

Move when source use permits, otherwise block and explain that the user must import/create an independent asset for the new project. Never create shared folder membership.

#### Mixed selection and creation atomicity

Selections may combine Library root and regular-folder assets. Native preflight validates the whole deduplicated selection, then one transaction creates the project folder and files every valid asset. A protected asset from another project blocks the entire create before any folder/membership commit; a race repeats the same validation in the transaction. Missing catalog IDs are omitted with a structured warning as above, and if none remain the result follows the explicit Empty project path. No partial source-project transfer is allowed.

#### Duplicate project names

Allowed. IDs distinguish folders. Both show Project marker; optionally show secondary timestamp/ID hint in selection UIs.

### Rename

Project JSON title is canonical. The desktop applies its 120-grapheme project-title contract before sending the folder title; the server accepts up to 200 characters and permits duplicate titles. The desktop function trims, substitutes `Untitled project` for empty input, and truncates overlong legacy/input text once at a Unicode grapheme boundary. A legacy title changed by normalization is persisted to the project and reported once when reconciliation succeeds.

Rename flow:

1. Normalize once with the shared rule above.
2. Persist title/revision locally.
3. Native updates folder title and queues/rebases cloud update.
4. Serialize/revision requests so older completion cannot overwrite newer rename.

If native write fails, project is `repair-needed`; retain user title and retry. If cloud update fails, local rename remains valid/pending.

### Manage project from Library while closed

- Open marked folder and browse same members Editor will show.
- Add/remove assets by target `projectId` without opening project.
- Rename through an explicit Rename project action; the generic folder editor remains unavailable.
- Remove unused assets after closed-project usage check.
- Used asset removal explains project and timeline/composition owner.
- Explicit Open project action switches surfaces; browsing/mutation alone does not.

“Same members” is an inventory guarantee, not necessarily identical card layout. A composition member/internal node may be represented under a composition card in Editor and with a Composition badge/group in Library. Counts and membership queries include it in both places, and neither surface may treat it as an unowned loose file.

### Remove from project

- Check target project's full usage.
- Block when used by timeline, slideshow, composition member/node, main audio, storyboard, or protected cabinet role.
- If unused, remove from project folder to Library root (or let user choose a regular destination).
- Update canonical folder, pending cloud op, compatibility mirror, Library, and Editor in one revisioned workflow.
- Never delete media or affect another project membership.

### Delete from Library

- Refresh usage snapshots for every stored project, open or closed.
- If any use exists, block and list project/owner labels.
- If unused but in a project folder, confirmation explains project membership removal.
- Native transaction removes creation, folder membership, transitional project cache/usage, and permitted local media.
- Reconcile affected project mirror and views.

Until all-project checked delete exists, hide/disable global Delete in project folders and offer Remove from project only.

### Move between project and regular folders

- Moving between regular folders keeps existing behavior.
- A creation cannot simultaneously be in a regular folder and a project folder.
- Moving a project asset to a regular folder is Remove from project plus a destination move: block when used, otherwise confirm and update project/Editor.
- Moving a regular-folder creation into a project is Add to project and removes its regular filing.
- Deleting a regular folder returns its members to Library root; it cannot directly remove canonical project assets because those are not members of that regular folder.
- A legacy project reference to a creation still in a regular folder is reported by the permanent outside-reference diagnostic, not treated as supported project membership.

### Delete a project

There is no project deletion flow today, so a project folder cannot be deleted as a substitute. If project deletion is added later, make it a project lifecycle action with explicit choices (recommended default: convert its folder to a regular folder and preserve files). **Shipped release path:** convert locally and enqueue ownership-asserted **delete** + **create** of the same folder id as a regular folder (empty-meta `update` is rejected with `project folder marker cannot be changed`). Sync uploads that pair in the same delete/release action.

### Composition behavior

- `StillWorkstream.memberIds` and non-discarded node creations are protected.
- Internal nodes remain hidden but cannot be Library-deleted.
- Explicit discard updates workstream + usage first, then may delete that generated node.
- Removing a composition/member updates usage before Library permits removal/delete.
- Same behavior applies whether project is open.

### Remote change while project closed

- Remote add appears in marked folder and Editor on next/open refresh.
- Remote unused removal disappears from project/mirror.
- Remote used removal is rejected/corrected and reported.
- Remote rename/deletion cannot detach project identity.

### Project folder appears on another device without its project document

Because project documents are currently local, a client may receive a marked project folder whose project JSON is unavailable on that device. Show it as “Project unavailable on this device.” Browsing/downloading may proceed, but membership mutation, rename, project deletion, and global file deletion fail closed because timeline/composition usage and source-project intent cannot be audited. Cloud snapshots from the owning machine remain authoritative on the unavailable machine; it must not fabricate ownership or send corrective project mutations.

## Legacy project open compatibility

Do not build a general migration engine or folder-choice UI. Put one deterministic compatibility check in the normal Open project path:

```text
if a folder is already marked with project_id = project.id:
    reconcile it and open
else if exactly one valid legacy bound folder can be resolved:
    claim that folder and open
else if the legacy project has no assets:
    create its required empty project folder and open
else if every legacy project asset is at Library root:
    create its required project folder, file those assets into it, and open
else if every legacy project asset is filed in the same claimable regular folder:
    claim that folder and open
else:
    block open with a detailed explanation
```

The bound-folder check intentionally comes before inference because it records explicit prior intent. A bound folder is valid only when its ID is unambiguous across the existing frontend/native binding records, the folder exists, and it is regular/unclaimed (or is already claimed by this project). Conflicting binding records are not guessed through; the asset-location rule may still independently produce an unambiguous candidate.

The empty-project and all-root cases reuse the same idempotent folder creation required for every new project. Root assets have no `folder_items` owner, so filing the complete set into the new project folder cannot reinterpret or steal another folder's membership.

That is the entire mandatory legacy path. No migration tables, folder picker, wizard, per-file plan, copy/remap engine, rollback journal, or completion state. The all-root bulk filing is the sole compatibility-time asset movement.

### Define “all legacy project assets” conservatively

Build the inference set as the union of:

- `StoredProject.creationIds`;
- native compatibility `project_assets` rows;
- members of still-existing legacy `folderIds` attachments;
- every creation returned by `collectProjectAssetUsage(project)`, including timeline, audio, slideshow, composition internals, storyboard, and cabinet references.

The usage-derived IDs are included because older writers did not consistently mirror hidden/internal creations into `creationIds`; for an unbound project they are conservative ownership evidence during inference. A valid explicit bound folder still wins and may leave such IDs as outside references. After cutover, usage and ownership are separate concepts: reference creation commands must first establish folder membership, while legacy outside references remain protected but do not appear in Editor Assets.

Deduplicate IDs before looking up their current `folder_items` locations. A creation present in the catalog with no `folder_items` row is at Library root; it is distinct from a missing creation.

For an **unbound** project, resolution succeeds only when the complete non-empty set is either entirely at root or has the same single `folder_id`. Unbound inference fails when any creation is missing from the catalog, root and foldered assets are mixed, assets are spread across folders, a folder belongs to another project, or the candidate folder is otherwise unclaimable. Folder name and partial/majority overlap are never evidence.

A valid marked/legacy bound folder is explicit ownership evidence and wins without requiring every old ID to exist or be located there. Missing/outside referenced IDs are reported by the post-open repair diagnostic. Corrupt/unreadable project JSON still blocks because neither usage nor the binding decision can be audited safely.

This conservative union may block a messy project that could theoretically be guessed. That is intentional: blocking preserves data and asks the user to perform ordinary Library organization; guessing could silently choose the wrong project root.

### Claim behavior

One idempotent native transaction re-runs detection and accepts only the resolution produced by the rules above:

1. Revalidate a marked/bound folder's identity and claimability; for unbound inference, revalidate every asset location and the empty/all-root/single-folder result.
2. Claim the existing folder or create exactly one new folder, then set `kind='project'`, `project_id`, and the project title.
3. Preserve an adopted folder's current members exactly; for the all-root case, insert every resolved legacy asset into the new folder and fail the whole transaction if any asset is no longer at root.
4. Clear the obsolete native binding row and replace/assert the transitional native `project_assets` cache.
5. Rebase/queue the required folder metadata/membership sync operations and increment the membership revision.

After native commit, persist the returned canonical member IDs to `StoredProject.creationIds`, clear `boundFolderId/folderIds`, refresh usage, and only then open the project. Those localStorage writes cannot be part of the SQLite transaction. If they fail, show retry and leave the native claim intact; the next open finds the already-marked folder and repeats the one-way JSON reconciliation. Never create or claim another folder during that retry.

Nothing else moves or changes. Current folder members become project assets. Other folders remain ordinary Library folders. The app neither nests folders nor automatically moves already-foldered assets, duplicates, deletes, or remaps creations.

When a valid bound folder is adopted, old asset IDs outside that folder remain untouched in Library. References to them continue working under the outside-reference rule below; unused IDs cease to be project assets when the compatibility mirror is refreshed. The explicit old binding, rather than a location guess, is the reason this case is safe to resolve automatically.

### Blocked-open popup

Failure returns structured reasons to one explanatory modal; it is not a wizard and offers no folder selection or file mutation. Show:

- the project name and “This project could not be assigned a project folder safely”;
- why no bound folder qualified: none, missing folder, conflicting binding IDs, or owned by another project;
- every relevant folder with asset count and names/IDs;
- separate Library root and Missing sections;
- the conflicting project name when a candidate folder is already owned;
- a recovery instruction matched to each blocker:
  - movable files: in Library, place the complete available set into one claimable regular folder or move all of it to Library root, then reopen;
  - files in another project folder: first open the named owning project and replace/remove any protected use before moving the original; the strict one-folder model cannot repair shared ownership automatically;
  - missing creations: restore the original catalog creation ID through normal sync/backup repair; importing a new file with a new ID does not satisfy the old reference;
- **Open Library** and **Close** actions only.

Do not write a “blocked,” “reviewed,” or partial-reconciliation record. Re-run the same read-only detection on every open. Once the user has organized the files into one supported layout, the next open resolves it automatically. A protected cross-project use or irrecoverably missing creation can therefore be a hard block under the deliberately strict model; say that plainly instead of presenting an action that cannot work. This plan adds diagnostics, not a remap/restore wizard.

### Existing timeline/composition references outside the folder

Preserve them. Timeline/composition state continues resolving creation IDs from the Library catalog even if those creations are not current project assets.

Compute one general invariant diagnostic on project load:

```text
referenced creation IDs - project folder member IDs
```

If non-empty, show “N referenced files are outside the project folder” with Open in Library. This diagnostic is permanent repair/safety behavior, not legacy state or migration code.

The user moves/imports files through normal Library actions and replaces/removes references through normal Editor actions. Used external references remain included in the global usage index, so Library deletion is blocked whether the project is open or closed.

An outside reference does not appear as a normal Editor asset. It may appear in the warning's repair list so the user can locate it. Playback/render continues while its catalog/media row exists.

All commands that create or change a timeline/composition reference after cutover must atomically verify that the target creation belongs to the project's marked folder (filing it first through the checked Add flow when allowed). Existing outside references may be played, removed, or replaced, but cannot be used as a precedent for creating another one.

### Minimal legacy cases

- **Existing valid bound folder:** claim it directly without asking, even when the old inventory contains outside IDs.
- **No binding; all assets in one regular folder:** claim that folder directly. No wrapper folder is created.
- **No binding and no assets:** create the required empty project folder directly.
- **No binding; all assets at root:** create the project folder and file the entire set into it in the claim transaction.
- **Assets split across folders:** block and group the popup details by folder.
- **Root and foldered assets mixed:** block and list root separately.
- **Any unbound inferred asset missing:** block and list it separately; do not mistake it for a root asset. A valid marked/bound project opens and reports that ID in repair diagnostics instead.
- **One attached folder contains all assets:** it is inferred from actual membership, not from attachment metadata.
- **Several attached folders:** their member IDs enter the inference set; claim only if all IDs nevertheless resolve to one folder, otherwise block.
- **Same bound/candidate folder for several projects:** the first completed claim owns it; later opens block and name that project unless their assets independently identify another claimable folder.
- **Frontend/native binding IDs disagree:** do not treat either as a valid binding; use unambiguous asset inference or block.
- **Candidate folder contains extra files:** they become project assets; the user can move unused files out later.
- **A file is referenced by several projects:** one project may own its folder; another project can keep the outside reference but must use an independent creation to satisfy membership.
- **Local-only files:** unchanged; their existing cross-device limitation remains.
- **Corrupt/unreadable project JSON:** block because usage cannot be audited. Missing creation/media under a valid marked/bound project is a post-open repair diagnostic; under unbound inference, a missing creation row blocks as above.
- **Claim interrupted or raced:** rerun detection and the idempotent claim on next open; never leave a second folder.

### Compatibility lifetime

Keep only the legacy field reader, deterministic detector, and blocked-open explanation. Isolate them in one module so they can be deleted together later. Do not preserve the old bind/attach UI.

No compatibility completion tracking is required: existence of exactly one `folders.project_id = project.id` row is sufficient.

## Native API plan

Illustrative project-oriented commands:

```text
library_reconcile_legacy_project_folder(
  project_id,
  title,
  bound_folder_ids,
  legacy_asset_ids
) -> Ready(ProjectFolderReconcileResult) | Blocked(ProjectFolderBlockers)

library_get_project_folder(project_id) -> LibraryFolder
library_list_project_asset_ids(project_id) -> string[]
library_list_project_outside_references(project_id, referenced_creation_ids)
  -> OutsideProjectReferenceResult
library_rename_project(project_id, title, title_revision) -> LibraryFolder

library_add_project_assets(project_id, creation_ids)
  -> ProjectAssetMutationResult
library_remove_project_assets(
  project_id,
  creation_ids,
  expected_usage_snapshot,
  destination_folder_id?
)
  -> ProjectAssetMutationResult

library_mark_project_usage_stale(
  project_id,
  expected_document_revision,
  next_document_revision
)
library_replace_project_usage(project_id, document_revision, usage_rows)
library_check_creation_usage(creation_ids) -> ProjectAssetUsagePreview[]
library_delete_creation_checked(creation_id, complete_project_usage_snapshots)
  -> DeleteCreationResult

library_import_project_asset_paths(project_id, paths)
library_file_generated_project_assets(project_id, creation_ids)
```

`library_mark_project_usage_stale` is the pre-localStorage write barrier and must compare-and-set the expected previous token, rejecting a mismatch; opaque revision tokens are not numerically ordered. `ProjectUsagePreview` is explanatory only; no destructive command may rely on an earlier preview result. A `ProjectUsageSnapshot` contains project ID, `documentRevision`, and the complete collector output. The checked remove/delete commands refresh or validate the required snapshot(s) and make the final decision inside their own SQLite transaction while the frontend mutation coordinator holds its lock. The global-delete snapshot set must contain every local stored project, including unresolved legacy projects; a corrupt/missing row aborts before native mutation.

### Project folder resolution

Replace nullable/inferred `resolve_project_folder` with required lookup by `folders.project_id`. For a new project, missing folder triggers idempotent creation. On legacy open, a missing marked folder invokes `library_reconcile_legacy_project_folder`; it applies only the bound, empty, all-root, and single-folder rules above and otherwise returns structured blockers.

### Checked membership mutation

Within one SQLite transaction:

1. Resolve target marked folder.
2. Replace/validate the required usage snapshot and its exact `documentRevision`; a stale read-only preview is irrelevant.
3. For removal/move from another project, reject protected source use.
4. Apply the target folder move while preserving the one-folder uniqueness constraint.
5. Do not auto-duplicate or rewrite project references.
6. Update transitional `project_assets` cache or assert derived equality.
7. Enqueue/rebase folder sync ops for cloud IDs.
8. Increment membership revision and commit.
9. Emit project/folder update after commit.

### Checked global delete

Refresh all project usage snapshots and delete in one native transaction. Fail closed if any known project's usage revision is absent/stale, any supplied project set disagrees with native known project folders/usage/binding rows, or an orphaned project folder cannot be audited. Return structured blockers/affected project IDs.

### Protect generic folder commands

- Generic rename/delete rejects `kind='project'`.
- Generic add/remove by project folder ID delegates to project-aware checks or rejects with “Use project action.”
- Generic moves/add-to-regular-folder inspect each creation's **source** folder. If the source is a project folder, route through checked Remove from project (and block protected use) before moving. This closes the bypass where a regular-folder action could otherwise pull a used file out of a project.
- New folder from selection follows the same source-folder checks.
- Project folder title changes only via rename project/reconcile.
- Project folder deletion only via future Delete project workflow.

## Frontend changes

### Project store/Shell

- Add schema version and the new-project provisioning state.
- Add `documentRevision` and route every project write through the mutation coordinator; the existing permissive loader/save functions are not safe for checked deletion.
- Make persistence errors observable and lifecycle methods async.
- Run project folder/usage reconciliation at Shell startup, not Editor mount.
- Add project-ID-addressable operations for closed projects.
- Centralize `collectProjectAssetUsage`.
- Treat folder membership as native authority; `creationIds` is transitional mirror.
- Remove attachment/binding runtime APIs after cutover.

### Library

- Render marker from `folder.kind`, independent of open project.
- Browse/manage project folder by `projectId` while closed.
- Add Open project action separately.
- Remove binding/attachment menus.
- Hide Edit/Delete folder for project folders.
- Exclude project folders from ordinary FolderPickModal.
- Route Add to project through the checked singular-folder move.
- Use global usage checks for remove/delete.
- Show project/composition/timeline blocker details.

### Editor

- Delete attached-folder cards/bound hydration.
- Read flat project folder members as Assets.
- Remove bind/unbind props/context actions/locks.
- Use shared add/remove and usage service.
- Keep composition presentation but include it in protection index.

### Generation/jobs

- New payloads pass project ID only.
- Native completion resolves folder and commits creation + membership.
- Remove/replace `boundFolderLanding.ts` generic folder calls.
- A job with `projectId` waits/fails repairably until that project's marked folder is ready; it never falls back to root and then creates an outside reference.
- A legacy job with only a bound folder ID files into it only when that folder now resolves unambiguously to a ready project. Otherwise its output lands unowned at Library root with a warning and is **not** added or referenced by any project automatically.

## Rollout with gates

### Blocking dependencies before cutover

1. Folder API JSONB marker round-trip and protected generic mutations while retaining singular membership. **Satisfied in production.**
2. An exhaustive, tested project-usage collector including compositions.
3. The deterministic legacy reconcile command and detailed blocked-open popup.
4. One shared revisioned project-membership service used by Library and Editor.
5. One mutation coordinator that serializes project saves, usage snapshots, membership changes, and checked deletes.

Mandatory-folder behavior and removal of old binding UI must not ship until all five gates are satisfied.

### Desktop implementation record

- **Complete:** additive folder identity/usage/membership schema, invariants, and compatibility cache derivation.
- **Complete:** deterministic marked/bound/empty/all-root/single-folder reconciliation and detailed blocked-open explanation.
- **Complete:** provisioning/ready/repair-needed lifecycle with idempotent Retry setup and project/folder rename repair.
- **Complete:** strict all-project usage indexing for timeline, slideshow, generation, composition internals, audio, storyboard, and cabinets.
- **Complete:** one mutation queue for project saves, native membership changes, legacy open/provisioning, folder sync, and global checked deletion, including catalog-existence validation for newly introduced references.
- **Complete:** Library management of open/closed local projects, unavailable-project fail-closed behavior, Project markers, and removal of binding/attachment actions.
- **Complete:** Editor asset inventory cutover and project-ID routed imports/generation/composition handling.
- **Complete locally:** project metadata/membership snapshot merge, local-wins project identity/title, used/stale remote-removal correction, local-only preservation, and duplicate remote-membership rejection.
- **Retained for one release:** legacy field readers plus native compatibility commands; no frontend binding writer or menu remains.
- **Complete externally:** production Folder API JSONB metadata, project-marker protection, generic-client rejection, duplicate-title compatibility, and end-to-end smoke verification.
- **Release preflight still required:** populated legacy profile copies, failure injection across cross-store boundaries, and mixed old/new client sync tests.

### Phase 0 — Characterization/design proof

- Build fixtures for bound/single-folder/all-root reconciliation, blocked details, outside-reference diagnostics, sync, and user stories.
- Lock regular folder sync tests.
- Implement exhaustive usage collector tests.
- Prototype the blocked-open explanation, outside-reference warning, and project-folder sync protection.
- Keep project titles within the stricter desktop 120-grapheme contract and the server's 200-character folder limit.

**Gate:** project metadata round-trips through server snapshots/ops; deterministic cases return the expected resolution; outside references are detected without mutation; no reference kind is missing from usage collector.

### Phase 1 — Additive schema and safety primitives

- Add folder kind/project ID plus membership/usage tables and revisions.
- Add protected folder APIs and checked removal/delete.
- Add the strict project loader, `documentRevision`, and mutation coordinator before enabling any destructive project-folder action.
- Replace snapshot wipe with merge/project conflict policy.
- Keep the legacy field reader and `project_assets` compatibility adapter isolated.

**Gate:** regular-folder behavior remains stable; project metadata survives every snapshot/conflict; used remote removals are corrected; unavailable-project folders remain locked without being treated as locally owned; operations are idempotent.

### Phase 2 — Legacy open reconciliation

- On open, claim a valid bound folder, claim the one folder containing all assets, create an empty folder, bulk-file an all-root asset set, or return structured blockers.
- Replace the compatibility `creationIds` mirror with folder members and compute permanent outside-reference warnings.
- Index all projects, open or closed.
- Verify folder members = project assets before ready.
- Clear that project's legacy binding/attachment fields immediately after successful claim.

**Gate:** repeated/failure-injected reconciliation creates no duplicate project folder; only the all-root case moves assets; a race rolls back fully; all timeline/composition references and blocker details remain stable.

### Phase 3 — Library/Editor cutover

- Both surfaces read folder membership.
- Add closed-project Library management/revision events.
- Remove binding/attachment UI and Editor folder cards. An unresolved legacy project shows only the explanatory blocked-open popup before returning to Library/project picker.
- Add Project marker and checked Add/Remove/Delete.
- Make create/rename async/repair-aware.

**Gate:** Library/Editor remain identical through local/remote changes; closed-project usage blocks correctly.

### Phase 4 — Output path cutover

- Route imports/generation/composition outputs by project ID.
- Handle background/legacy jobs.
- Remove new bound-folder payloads/calls.

**Gate:** every project-ID output lands once in the canonical folder and appears immediately in both views; an ambiguous pre-cutover bound-only job is the sole unowned-root exception and creates no project reference.

### Phase 5 — Observe before cleanup

- Ship the isolated legacy detector/field reader for at least one release.
- Update older binding plans.
- Later remove the detector, bindings, writable `project_assets`, and legacy JSON reader after usage confirms legacy projects have been reconciled or abandoned.

**Gate:** no remaining legacy project needs reconciliation and no legacy writer remains.

## Test matrix

### Invariant/native

- One marked folder per ready project; duplicate titles allowed.
- Folder members equal project asset query/cache.
- Generic project-folder mutation rejected.
- Regular-folder move/new-folder actions cannot bypass protected project removal through the source creation ID.
- Add/remove memberships transactionally and revisioned.
- One creation cannot occupy multiple folders; reuse requires a separately imported/created asset.
- Used asset cannot leave project folder.
- Global delete blocks any open/closed project use.
- Stale/missing usage fails closed.
- Project edit versus remove/delete interleavings serialize; neither a stale usage window nor a new dangling reference is possible.
- Crash/failure before localStorage, after localStorage, and during usage replacement leaves either the prior ready snapshot or an explicit native `stale` barrier; it never leaves an apparently current old index.
- Malformed project JSON and an incomplete all-project snapshot disable global Delete instead of silently dropping a project.
- Document, membership, and cloud revisions advance independently and are never compared across domains.

### Sync

- Project marker survives snapshot.
- Local project title beats remote rename.
- Remote deletion recreates/repairs folder.
- Remote add updates closed/open project.
- Remote unused removal accepted.
- Remote used removal/move rejected/corrective op queued.
- Pending operation rebases without duplicate loops.
- Local-only membership survives.
- Regular folder sync unchanged.

### Legacy open reconciliation

- Unbound/no assets; all assets at root; mixed root/foldered; all assets in one regular folder; assets across folders.
- Valid bound empty/populated/local-only/pending ops.
- Missing bound/attached IDs.
- Attached one/many/empty/shared.
- Bound + attached overlap.
- Same bound folder for several projects.
- Shared legacy creation remains an outside reference until the user moves it, supplies an independent asset, removes an unused reference, or defers.
- Frontend/backend/folder membership mismatch.
- Timeline/slideshow/audio/storyboard missing from `creationIds`.
- Workstream members/internal/promoted/discarded nodes.
- Cabinets/groups.
- Duplicate/corrupt rows, Unicode/empty/long titles.
- Interrupted/repeated claim, root-location race, localStorage failure after native commit, and orphan folder.
- Protected foreign-project and irrecoverably missing-creation blockers use honest, case-specific recovery text and perform no partial mutation.

### UI/lifecycle

- Create empty/from root/from regular/from another project.
- Idempotent Add and protected Remove semantics.
- Rename success/local failure/cloud pending/rapid ordering.
- Project marker open/closed.
- Closed-project Library add/remove.
- Library change updates Editor; Editor change updates Library.
- Remove/delete blocker names project and timeline/composition.
- New clip/composition-reference commands reject or first file a non-member; only pre-existing outside references remain possible.
- No binding/attachment/edit/delete-folder action.
- Regular folder UI unchanged.

### Jobs

- Import, local generation, Replicate, timeline fill, composition bake/edit.
- Completion with Editor/Library unmounted.
- Legacy project-ID ready/not-ready, bound-only unambiguous, and ambiguous unowned safe-root warning with no project reference.

### Preflight

- Typecheck and zero-warning lint.
- Frontend unit/integration suite.
- Rust library suite with real SQLite schema/reconciliation/sync fixtures.
- Manual legacy-open checks against populated profile copies.
- Failure injection at every cross-store/native transaction boundary.

## Acceptance criteria

- `project assets = project folder members` for every ready project.
- Library and Editor show same current assets without open-project dependence.
- Library manages closed projects.
- Timeline/composition use blocks removal/global deletion across all projects.
- Every legacy project resolves deterministically from a valid binding, empty inventory, all-root inventory, or a single containing folder; every other case blocks with actionable details.
- Shared assets never silently stolen.
- Project identity/title survives/corrects cloud conflicts.
- No binding/changing-binding UI remains.
- No project contains folder cards under current flat model.
- Imports/generation land by project ID in canonical folder.
- Legacy reconciliation is idempotent, moves assets only for the all-root case, and preserves all timeline/composition references.
- Checked removal/deletion and project-reference writes have no time-of-check/time-of-use gap.
- The small detector/field reader/blocked explanation is isolated for later deletion.

## Requirements adjusted for a safe result

1. A new provisioning project cannot open; a legacy project opens only after deterministic folder reconciliation and then uses permanent outside-reference warnings as needed.
2. Existing one-creation/one-folder membership remains; reuse across projects requires a separate imported/created asset or a safe Move.
3. Legacy reconciliation asks no questions: accept a valid binding, infer only complete single-folder/all-root layouts, and block every ambiguous layout until the user organizes it in Library.
4. Local project title/protected usage can override remote project-folder changes to keep projects valid.
5. Global deletion fails closed when any project document/usage index cannot be audited.
6. Only a small isolated legacy detector/field reader and explanatory block remain temporarily; no general migration framework is introduced.

These adjustments preserve the requested one-to-one folder model while addressing, rather than avoiding, its synchronization and legacy-data consequences.
