# Plan: Project v2 container (groups weeds)

Weeds under [PLAN-shot-session-refs-ledger.md](./PLAN-shot-session-refs-ledger.md). Surgical. Proves a Parascene project container. Does not migrate v1. Does not teach www groups v2. Chat, ShotSpec, ledger, refs stay on the parent plan.

Not the leftover track (last Videos Remove, Help map).

## Decisions

A project can exist two ways. Desktop speaks both. We do not deprecate or convert v1.

- v1 — today’s project: local document, `kind: project` folder, Images/Videos cabinets, v1 groups. Existing projects stay this forever unless someone remakes them.
- v2 — new Parascene Creation, type project. The container is a group v2: a list of 1-to-1 view+pointer rows. The group row is the tile. No extra cover Creation.

v2 is only for projects. Packs, cabinets, Library “group” in the old sense stay v1 wrap (`POST /api/create/images/group`, ungroup/regroup, moving cover id). Desktop v2 code is behind “this project is v2,” not a global group rewrite.

www does not adapt to v2. The API may costume a v2 project as an old group so the existing www group UI can show the tile and the list. www / old group UI must not mutate v2 (read-only or API rejects). Desktop GET asks for no costume and reads `items[]`. Desktop writes v2 only for v2 projects.

1-to-1. View is the list row (image / video / audio). Pointer is the detail when you select or use it. Create writes one pair. Remove drops both. Cover is a flag on one row, not a third object. If it is not in the list, it is not a member. No filing-for-view (no explode-cabinets, no file-the-cover-so-Library-has-a-tile).

Pointer kind is travel.

- Parascene Creation id — travels. Other machines and www can resolve it.
- `local://<libraryId>/<assetId>` — stays. `libraryId` is minted once next to this Library (not a path). This machine: id is mine, open the asset. Other desktop: id is not mine, blank, do not search the catalog. www costume: scheme is local, empty slot or omit. The API does not get a machine identity.

No local-only projects. Creating a v2 project always mints the Parascene project Creation. Local-only assets live as `local://` rows on that project.

Stable id. Membership and title/cover/meta changes never mint a new project Creation. Today’s cabinet dance (wrap, ungroup/regroup, “Cannot group deleted creations”) is v1 only.

Create-into-group. `POST /api/create` with `group_id` = the v2 project id. The output is born as a pair. No post-hoc `POST .../group`. The field already exists on create; generate never sent it.

Patch in place. Members and other data (title, which row is cover, lean meta). Not wrap-again. Fat editor state (timeline, playhead, drafts) stays on the desktop project document. Lean facts that should travel sit on the project Creation.

Library is a way to pick a v2 project. The tile looks like a folder, badged Project, can open the desktop project. Add To Folder can target a v2 project (same verb; write is a v2 pair, not `folder_items`). Later the chooser can go away; not a phase until Library open is how you actually work.

Adapters live on the Parascene API. Costume read for www. Raw v2 for desktop. Old groups unchanged. Desktop does not grow a second translator that fakes old group JSON as the source of truth.

Later (not this doc): same list primitive for folders; www speaks v2 for real; default New project is v2; refs as inner v2 lists; talk-only chat.

## Act on

Parascene (www API)

- Create a project-typed Creation that is a group v2 (empty list allowed). Publish forbidden.
- GET: default costume → old group JSON for www. Desktop flag: no costume, `items[]`.
- `POST /api/create` + `group_id` appends a pair, same id.
- Patch: add/remove item, title, cover flag, lean meta. Empty list keeps the id.
- Reject v1 group wrap/ungroup against a v2 id.
- Costume: Creation pointers become old members/snapshots; `local://` → blank or omit.

Desktop

- Every user-facing create is v2: Library New project… (selection becomes the first pairs) and chooser New project (empty list). Agent `createProject` too. v1 is only projects that already exist — open/generate/file still branch. We do not mint new v1s.
- Local document points at the Parascene project id. Open/generate/file branch on v1 vs v2.
- Library: v2 tile like a folder, Project badge, open. Add To Folder → v2 write.
- v2 Parascene generate sends `groupId`. No cabinet ensure/file.
- v2 Blue/Replicate generate appends `local://<libraryId>/<assetId>`.
- Mint `libraryId` once per Library.
- v2 reads/writes only on the project-v2 path. Cabinets and packs keep calling v1 group APIs.

## Scenario map

New project from chooser (no selection) — v2. Empty `items[]`. Library shows a Project folder-like tile.

New project… from Library selection — v2. Selected Creations (or `local://` rows) become the first pairs. Same tile / open path.

Agent createProject — v2. Same as chooser (empty) unless the action passes ids.

Existing v1 project — never auto-converted. Open/generate/file stay v1.

Open v1 — folder + cabinets. Old generate/file/remove.

Open v2 from Library or chooser — load local document + raw v2 list. Assets/Library-inside-project is `items[]`. No Images/Videos covers.

Open v2 on www — costume old group. Badge/indicate project if www already can; otherwise an unpublished group tile is enough. No publish. No ungroup. No remix.

Generate Parascene, v2 open — `group_id` on create. Pair appended. Same project id. Member hidden on home Library. View row in the project. Timeline may point at the new id (local doc).

Generate Parascene, v1 open — create → wait → cabinet group. Cover id may move. Untouched.

Generate Blue/Replicate, v2 open — local catalog row + `local://` pair. This machine shows it. www costume blank. Other machine blank (“not me”).

Generate Blue/Replicate, v1 open — local file into v1 project as today.

Add To Folder → regular folder — `folder_items`. Unchanged.

Add To Folder → v1 project folder — `folder_items` / cabinets as today.

Add To Folder → v2 project — append pair (Creation pointer if it is a Creation; `local://` if it is local-only). Same project id.

Remove item, v2 — drop the pair. Last item: list empty, project tile and id remain.

Remove last cabinet member, v1 — existing leftover (PLAN-last-cabinet-member-remove). Not this.

Rename / set cover, v2 — patch. Same id. Costume title/art follow.

www or old group UI mutates a v2 project — API rejects. Desktop is the writer.

Other desktop, same account — v2 project opens. Creation-pointer rows resolve after sync. `local://` other libraryId → blank, no catalog search.

Pack / creative group / cabinet — v1 only. Desktop must not run v2 helpers.

Transport (ffmpeg extract, ephemeral still_url) — not a pair. Never a list row.

Promote local → Creation — later, explicit. Rewrite the pointer. Not hidden upload.

## Phases

Each phase ends when an ordinary user can do the check without DevTools. If they cannot tell, it is not a phase.

Phase 1 — A v2 project you can see and open

Chooser New project: empty Project tile in Library, open empty Editor, no Images/Videos cabinets. Library: select stills, New project… — those assets are the rows. Quit, reopen, same tiles, same ids. An older v1 project still opens with cabinets. On www, a new project shows as an unpublished group-like tile; Publish is not offered or it fails. Ungroup/remix if present must fail.

Done when: both New project entry points make v2 tiles you can reopen; a pre-existing v1 still opens as v1; www can see a new project and cannot publish it.

Phase 2 — Credits generate stays in that project

Open the v2 project. Parascene Text to Image. The still appears inside the project (Library open / Assets). Home Library does not gain a new loose still. The project tile is the same id as phase 1. Generate a second still: two rows, still that id. Open a v1 project and generate: cabinets still work (Images cover may be new — that is v1).

Done when: two credits stills live only in the v2 project, the project id never changed, and a v1 generate still files like today.

Phase 3 — Add To Folder into the v2 project

In Library, take an existing Creation (not from this project) and Add To Folder → the v2 project. Open the project: that still is a row. Project id unchanged. Add To Folder into a regular folder still works. Add To Folder into a v1 project folder still works.

Done when: one Add To Folder click puts a known still into the v2 project, and the other two Add To Folder targets still behave.

Phase 4 — Remove, including the last row

Remove one still from the v2 project. It leaves the project, stays in Library if it is a Creation. Remove until empty. The project tile is still there, same id, opens empty. www still shows the project (empty group costume), not a missing tile and not a new id.

Done when: you can empty a v2 project without losing the project, and a Creation you removed is still in Library.

Phase 5 — Local generate is this-machine

Open the v2 project. Direct to Blue or Replicate still (Settings creds). This machine: the still is a row in the project and opens. www: that slot is blank or missing; the credits stills from phase 2 are still visible in the costume. The stored pointer is `local://<libraryId>/<assetId>` (same libraryId for everything from this Library). v1 Blue/Replicate generate still lands as today.

Done when: you can point at one local row that only this desktop shows, and www still shows the credits rows and a hole (or omit) for the local one.

Phase 6 — Rename the project

Rename the v2 project on desktop. Library tile title updates. Reopen: same id, new title. www costume title matches. Do not get a second project tile.

Done when: one rename, one tile, two places (desktop Library and www), same id.

## Not this doc

Talk-only Assistant, ShotSpec tools, ledger, reference bundles, cleanup task, folder-as-v2, retire the chooser, promote `local://` to a Creation, last Videos cabinet Remove, Help leftover.
