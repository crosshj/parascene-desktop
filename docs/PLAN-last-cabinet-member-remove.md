# Plan: Remove the last still or clip from a cabinet

Huge gap. Near-term. The last image in Images, or the last video in Videos, must leave the project the same way any other asset does. Library keeps the file. No catalog edit. No second project.

This bit us while recapturing Help Audio to Video screens. After a clip existed, Remove threw or the tile bounced. Editor remount recovered the Videos cover and exploded the member back onto Assets. We had to mint a clean project just to get an empty video lane.

## What is broken

- Images / Videos are containers. Assets shows members, not the cover.
- The last member often lives only in group meta. It is not a `folder_items` row.
- `library_remove_project_assets` only unfiles folder members. Last clip / last still is a no-op or an error.
- “Delete from group” is a cloud delete, not “take this out of the project.”
- Clearing `videosGroupId` / `imagesGroupId` does not stick. Open and remount run `recoverMissingCabinetIdsFromCreations` if the stamped cover is still on the project. Folder reconcile writes the cover back. Assets expands the member again.
- Local hide in memory dies on the next persist or remount.

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

- `library_remove_project_assets` accepts cabinet members, not only `folder_items`.
- Last member ungroups; empty cover unfiles; pointer-clear is part of the same write.
- Do not throw because the folder would have zero video (or zero image) tiles.

Store and recover

- A cleared `imagesGroupId` / `videosGroupId` means “no cabinet,” not “find one.”
- Recover stamped covers only when the user (or generate) asks for a cabinet again.
- Folder remirror must not re-add a cover we just removed.

Editor

- Remove from project on the last still or last clip uses the path above. Confirm stays “Remove,” not a Parascene delete.
- Keep “Delete from group” for actual cloud delete. Do not force that path to empty a cabinet.
- After remove, Assets has no leftover video/image tile. Selection moves off the gone id.

Proof

- Project with one still in Images: Remove → Images empty, still still in Library, reopen stays empty.
- Project with one clip in Videos: same.
- After Audio to Video has written a clip: Remove that clip → V1 can be empty, Assets has no video tile, speech and still stay. Help recapture does not need a second project.

## Done

- Last Images member and last Videos member leave via UI Remove.
- Native remove does not throw on that last id.
- Library still has the file.
- Remount / reopen / reconcile does not bounce the tile or the cover.
- Empty cabinet is gone from the project folder.
- No SQLite hand-edit. No “make another project that looks like this one.”
