# Plan: Remote / local consistency tests

This is the same-object track, not leftover Help coverage. Strategy: [GUIDE-help-and-tests.md](./GUIDE-help-and-tests.md).

Help can describe this computer vs the cloud. Suites 01–07 prove journeys and Help media. They do not prove one object stays the same object after a flow.

That is why desktop and web drift: nothing fails when a cover bounces, a local-only file is pruned, a project folder remirrors members, Sync counts lie, or delete project eats media.

# What 01–07 actually assert

- 02 — clear local, newest adds some rows, some folder has members, some thumb, some media. Counts only. Not which ids.
- 03 — create project binds a project folder. No Sync. No cabinet. No delete-and-keep-media.
- 04 — regular folder ≠ project folder. Both empty. No cloud.
- 05 / 06 / 07 — generate works, files exist, teardown sweep. No “still on the website,” no cabinet contract, no remount.

Unit tests mock the catalog. They cannot see live Parascene.

# Agent cannot see the invariants yet

`library.lookup` now also returns origin, `localOnly`, `remoteUrl`, thumb path, download state, folder ids, group kind, member ids, cabinet pointers.

`cloud.lookup` `{ id }` is wired. 404/410 is `found: false`.

`project.assets.remove` / `project.assets.delete` share the Editor Assets path.

# Assets panel — Remove vs Delete

The Editor Assets menu must offer both on every real asset (loose tile, Images/Videos member, last member). Timeline use is the only blocker.

Remove from project

- Leaves the project. Library keeps the file.
- Parascene Creation stays. If it was in an Images/Videos group, the website group updates (ungroup). Sync and remount do not put it back in the project.
- Local-only: unfile only. No cloud call.

Delete

- Leaves the project and Library.
- If the user is deleting a Parascene Creation, the website deletes it too (and the group updates). `cloud.lookup` is 404. Sync does not resurrect it.
- Local-only: local delete only. `cloud.lookup` stays 404.

Assets now offers Remove and Delete on every real tile, including cabinet members. Remove ungroups; Delete deletes the Creation when it is on Parascene. Last Images member Remove is proven in suite 10. Last Videos member still needs a clip (A2V).

Agent needs `project.assets.remove` and `project.assets.delete` on the same path as the menu. Tests do not click a second, quieter code path.

# Invariants

Each test: invoke setup → user flow → assert local catalog and, when Parascene-backed, the same id on or off the website.

- Parascene generate: one Creation id locally and remotely. File on disk. Project folder shows the Images cover, not loose members. Thumb present. Sync newest does not duplicate or drop it.
- Local-only (Add from disk / Direct to Blue / Replicate): no website Creation. Sync newest does not prune it.
- Delete project: document gone. Library file stays. Website Creation stays. Folder becomes regular or empty-delete without deleting media.
- Cloud delete, then Sync: local row gone. No ghost cover.
- Folder sync: members match both sides for a folder this run created. Conflicts later.
- Project folder: exactly one, kind project. Images / Videos covers plus local-only. Members are not loose tiles. Reopen is the same.
- Assets Remove / Delete: both work on loose tiles and cabinet members. Suite 10 proves last Images member Remove, Parascene Delete, local-only Delete, and timeline refuse. Last Videos member still needs a clip (A2V). See PLAN-last-cabinet-member-remove.md.
- Thumbs / media: after `sync.thumbs` / `sync.media`, every cacheable row this run owns has `localThumbPath` / `localPath`. Check rows, not `withThumb > 0`.
- Groups: cover exists, source ids exist, opening a group does not file members into the project folder.
- Later: a cleared catalog on this machine restores the same Creation ids. The project document does not come back.

# Phases

0 — Done. `library.lookup` inspects origin, disk, folders, group, cabinet. `cloud.lookup` treats 404 as a result. `project.assets.remove` / `project.assets.delete` use the Assets-panel path. No screenshots.

1 — Done. Suite 08 (`integration/08-identity.integration.test.ts`) passed on a signed-in `npm run dev` app. Cheap generate → inspect → `sync.start` → same id → `project.delete` → file and remote remain → `cloud.delete` → both gone.

2 — Done. Suite 09 (`integration/09-local-only.integration.test.ts`) passed. `library.import` → inspect local-only → `sync.start` does not prune → `cloud.lookup` 404.

3 — Done. Suite 10 (`integration/10-assets.integration.test.ts`) passed. Cheap generate: Remove last Images member → Library and website stay, remount empty. Delete a later Parascene still → local and cloud gone, Sync does not resurrect. Delete a local-only import. Timeline-used audio refuses both. Last Videos member still needs a clip (A2V); not in this run.

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

08–11 passed against a signed-in `npm run dev` app. They fail if that id drifts: duplicate covers, bounced last Images member, Remove hidden for cabinet members, Delete skipping the website, local-only pruned, delete project eating media, sync counts lying.

A change to folder, cabinet, or sync names which suite it affects.
