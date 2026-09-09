# Plan: Remove the last still or clip from a cabinet

Huge gap. Near-term. The last image in Images, or the last video in Videos, must leave the project the same way any other asset does. Library keeps the file. No catalog edit. No second project.

This bit us while recapturing Help Audio to Video screens. After a clip existed, Remove threw or the tile bounced. Editor remount recovered the Videos cover and exploded the member back onto Assets. We had to mint a clean project just to get an empty video lane.

## What is broken

Last Videos member is still unproven (needs a clip / A2V). Last Images member Remove is proven in suite 10.

Native `library_remove_project_assets` only unfiles `folder_items` rows. Editor Remove ungroups first, then unfiles the cover. Cabinet usage (`project_cabinet`) is not a timeline-style blocker, so the empty cover can leave the folder.

Pointer-clear must land in the same persist write as hiding the cover from `creationIds`, before native unfile. Otherwise Shell re-files the cover (pointer still set) and remount recover puts the member back.

Recover still restores a stamped cover that remains among project assets (generate). After last-member Remove the cover is unfiled first, so remount has nothing to recover.

## Contract

Remove from project on a cabinet member:

- Ungroup that id from the Images or Videos cover.
- Leave the Creation in Library.
- If the cabinet is now empty: unfile the cover, clear the pointer, drop the cover from `creationIds`.
- Timeline clips that still reference the id stay a blocker until those clips are gone. That is the only fuss.

Remove of the cover itself (empty or leftover): same outcome — cover leaves the project, pointer clears, members that are only in that cover leave the Assets grid. Media stays in Library.

Reopen, remount, sync, and folder reconcile must not put the member or an empty cover back.

## Phases

Native remove

- Done for last Images: `library_remove_project_assets` does not throw on cabinet usage when unfiling the empty cover.
- Last member ungroups in JS; empty cover unfiles; pointer-clear + hide from `creationIds` persist before native unfile.
- Last Videos member still needs a clip (A2V).

Store and recover

- After last-member Remove, the cover is not among project assets, so recover cannot bounce it.
- Recover still runs when a live stamped cover remains in the folder (generate).
- Folder remirror must not re-add a cover we just removed (pointer is already null).

Editor

- Assets offers Remove and Delete on every real asset, including the last still or last clip. Timeline use is the only blocker. “Delete from group” is gone; Delete is the cloud-delete verb.
- Remove from project on the last still or last clip uses the path above. Confirm stays “Remove,” not a Parascene delete. Library keeps the file. The website Creation stays. If it was in Images/Videos, the cloud group ungroups that id.
- Delete leaves the project and Library. If it is a Parascene Creation, the website deletes it and the group updates. Do not offer only “Delete from group” as a stand-in for Remove.
- After remove or delete, Assets has no leftover video/image tile. Selection moves off the gone id. Remount / Sync do not resurrect a removed member or a deleted Creation.

Proof

- Done: project with one still in Images — Remove → Images empty, still still in Library, reopen stays empty (suite 10).
- Not this run: project with one clip in Videos.
- Not this run: after Audio to Video has written a clip — Remove that clip → V1 empty, Assets has no video tile, speech and still stay.

## Done

- Last Images member leaves via Assets Remove (shared agent path). Native unfile does not throw on that cover.
- Library still has the file. Website Creation stays. Remount / reopen does not bounce the tile or the cover.
- Empty Images cabinet is gone from the project folder.
- Last Videos member and Help A2V recapture still need a clip.
