# Plan: Remote / local consistency tests

This is the same-object track, not leftover Help coverage. Strategy: [GUIDE-help-and-tests.md](./GUIDE-help-and-tests.md).

Help can describe this computer vs the cloud. Suites 01–07 prove journeys and Help media. They do not prove one object stays the same object after a flow.

That is why desktop and web drift: nothing fails when a cover bounces, a local-only file is pruned, a project folder remirrors members, Sync counts lie, or delete project eats media.

# What 01–07 actually assert

- 02 — clear local, newest adds some rows, some folder has members, some thumb, some media. Counts only. Not which ids.
- 03 — New project is v2. Library Project tile `project-v2-<id>`. Rename keeps that id. www costume empty / unpublished / same title. Close/reopen. Library Delete project shots. `project.delete` wipe. No Sync.
- 04 — regular folder ≠ Project tile. Both empty. No cloud.
- 05 / 06 / 07 — generate works, files exist, teardown sweep. 05 also asserts the goblin still on the project www costume. 08 is the cheap same-object generate.

Unit tests mock the catalog. They cannot see live Parascene.

# Agent cannot see the invariants yet

`library.lookup` now also returns origin, `localOnly`, `remoteUrl`, thumb path, download state, folder ids, group kind, member ids, cabinet pointers.

`cloud.lookup` `{ id }` is wired. 404/410 is `found: false`. `view: "www"` is the website costume.

`project.assets.remove` / `project.assets.delete` share the Editor Assets path.

# Assets panel — Remove vs Delete

The Editor Assets menu must offer both on every real asset (loose tile, Images/Videos member, last member).

v2 membership is the Parascene group list (`PATCH /api/create/group` remove, `DELETE` the Creation). Local timeline, in-flight generates, and leftover refs follow that API. They do not veto Remove or Delete.

Remove from project

- Drops the pair from the project group on Parascene and locally. Library keeps the file.
- Parascene Creation stays. www costume loses that member. v1 Images/Videos ungroups. Sync and remount do not put it back in the project.
- Local-only: unfile only. No cloud call.
- Timeline clips may still name the file. That is not a blocker.

Delete

- Deletes the Creation locally and on Parascene, and clears every project reference to it (including timeline clips).
- `cloud.lookup` is 404. Sync does not resurrect it.
- Local-only: local delete + clear refs. `cloud.lookup` stays 404.

Assets now offers Remove and Delete on every real tile, including cabinet members. Remove ungroups; Delete deletes the Creation when it is on Parascene. Last Images member Remove is proven in suite 10. Last Videos member still needs a clip (A2V).

Agent needs `project.assets.remove` and `project.assets.delete` on the same path as the menu. Tests do not click a second, quieter code path.

# Invariants

Each test: invoke setup → user flow → assert local catalog and, when Parascene-backed, the same id on or off the website.

- Parascene generate: one Creation id locally and remotely. File on disk. v2: the still is a pair on the same project id (www costume lists it). v1: project folder shows the Images cover, not loose members. Thumb present. Sync newest does not duplicate or drop it.
- Local-only (Add from disk / Direct to Blue / Replicate): no website Creation. Sync newest does not prune it.
- Delete project: warn, then wipe children (www costume + local leftovers), then the project. Seed `28006` is never swept.
- Cloud delete, then Sync: local row gone. No ghost cover.
- Folder sync: members match both sides for a folder this run created. Conflicts later.
- New project: one Library Project tile, same Parascene id, no Images/Videos cabinets. Reopen is the same. v1 leftover still uses a native project folder + cabinets.
- Assets Remove / Delete: both work on v2 pairs and v1 cabinet members. Suite 10 proves Remove last still (pair dropped, Creation stays), Remove of a timeline-used import (file stays), Parascene Delete, and local-only Delete (www omits `local://`). Last Videos member still needs a clip (A2V). See PLAN-last-cabinet-member-remove.md.
- Thumbs / media: after `sync.thumbs` / `sync.media`, every cacheable row this run owns has `localThumbPath` / `localPath`. Check rows, not `withThumb > 0`.
- Groups: cover exists, source ids exist, opening a group does not file members into the project folder.
- Later: a cleared catalog on this machine restores the same Creation ids. The project document does not come back.

# Phases

0 — Done. `library.lookup` inspects origin, disk, folders, group, cabinet. `cloud.lookup` treats 404 as a result. `project.assets.remove` / `project.assets.delete` use the Assets-panel path. No screenshots.

1 — Suite 08: cheap generate → inspect → www costume lists the still → `sync.start` → same id → `project.delete` (wipe children, then project) → project and member 404 both sides.

2 — Done. Suite 09 (`integration/09-local-only.integration.test.ts`) passed. `library.import` → inspect local-only → `sync.start` does not prune → `cloud.lookup` 404.

3 — Done. Suite 10 (`integration/10-assets.integration.test.ts`) passed. Cheap generate: Remove last Images member → Library and website stay, remount empty. Delete a later Parascene still → local and cloud gone, Sync does not resurrect. Delete a local-only import. Timeline-used audio Remove unfiles and keeps the file. Last Videos member still needs a clip (A2V); not in this run.

4 — Done. Suite 11 (`integration/11-thumbs-media.integration.test.ts`) passed. Cheap generate, then `sync.thumbs` / `sync.media`, then that id has `localThumbPath` and `localPath` on disk.

5 — Later: folder conflicts, two-machine, groups, Blue local-only.

# Constraints

Live Parascene. Already-signed-in test user. No Direct to Blue required for 08–11. Be gentle.

Do not teleport. Setup is `invoke`. Stay on the page a person would use.

Fail if leftover `agent-test-*` catalog rows remain. Teardown also flushes `folder_pending_ops` for those test folders (`sync.folders` with `dropTitleContains: agent-test-`).

Never delete seed still `28006` (account avatar). After tests the Library is that one unpublished 1:1 tile.

Help is not the proof. These tests are.

# Done

Lookup can answer origin, disk, folder, group, and cabinet for one id.

08–11 passed against a signed-in `npm run dev` app. They fail if that id drifts: duplicate covers, bounced last Images member, Remove hidden for cabinet members, Delete skipping the website, local-only pruned, default project delete leaving members, sync counts lying.

A change to folder, cabinet, or sync names which suite it affects.
