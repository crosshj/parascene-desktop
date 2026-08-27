# Plan: Guard against same-name project folders and accidental timeline length

User reports (@trl): two “my fault” cases that look like product bugs. Both leave the editor waiting on media or a render that never finishes.

## Seen in the wild

Same project name twice
- Delete a project, create another with the exact same name.
- Library shows two folders with that name when adding assets.
- Adds can land in the wrong folder → “No local file on disk”, preview `depwait`, broken thumbs.
- New project with a different name worked.

Duplicate audio far off-timeline
- Song added twice; second clip parked way past the visible span.
- Sequence duration balloons; render fails with “encoder stopped updating.”
- Deleting the stray clip fixed it.

## Goals

- Project folder identity must not collide on display name after delete/recreate.
- Adding from Library must target the open project’s folder only — never a same-named sibling.
- Accidental far clips should be hard to create and easy to notice before bake/render.

## Folder / name collision

- Prefer stable id for project↔folder binding; title is display-only.
- On create: if a same-titled folder already exists (orphan or prior project), do not silently reuse or twin it — rename prompt, or unique suffix, or attach only via `project_id`.
- On delete: clear or release the marker so a new project cannot leave two live folders sharing one title in the chooser.
- Library “add to project” picker: filter/disambiguate by `project_id`, not title string.
- Done when: recreate-with-same-name cannot produce two selectable folders for one open project, and adds always hit that project’s folder.

## Timeline length / stray clips

- After paste/add: keep playhead-relative placement; never default new audio thousands of seconds out.
- Surface sequence end in the editor (duration chip / zoom-to-fit) when end ≫ video coverage or ≫ last visible clip.
- Optional soft warn before render/publish when duration > N minutes or audio extends far past picture.
- Optional “select all / zoom to content” that reveals off-screen clips.
- Done when: a duplicate song cannot sit unnoticed far right, and render is not left encoding an accidental hour-long timeline without a clear warning.

## Adaptive timeline zoom

Today zoom is a fixed multiplier `0.5–3` on `TIMELINE_PX_PER_SEC` (8) → about 4–24 px/s. Short projects cannot zoom in enough; long ones cannot zoom out enough to see the whole sequence.

- Derive slider min/max from sequence duration + viewport width (not a global constant).
- Zoom out floor: at least “fit content in viewport” (so long songs / stray far clips are visible).
- Zoom in ceiling: enough px/s that a few seconds span the viewport (short tracks editable at clip/frame scale).
- Persist the user’s zoom preference, but re-clamp when duration or viewport changes.
- Optional: one-click “fit to content” next to the zoom scrubber.
- Done when: a ~30s cut can zoom in past today’s max, and a multi-minute (or accidental hour-long) timeline can zoom out to show end-to-end.

## Out of scope

- MSE preview reliability (separate work).
- Healing already-corrupt user libraries beyond folder disambiguation and UI warnings.
