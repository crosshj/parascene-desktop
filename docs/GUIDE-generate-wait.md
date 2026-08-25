# Guide: Generate wait (Parascene)

How Desktop waits after `POST /api/create`. Code: `wait_creation_loop` in `src-tauri/src/library/jobs.rs`. Filing after wait: [REQUIREMENTS-project-folders-cabinets.md](./REQUIREMENTS-project-folders-cabinets.md) §4.11. Source stills: [GUIDE-generate-source-images.md](./GUIDE-generate-source-images.md).

Hard rules

- Rust owns the wait. FE listens to `jobs-updated`. Safety-net may poll SQLite job rows, not `/api/create/images/:id`.
- One GET per tick. No inner retry. 403 is not 401. Honor `api_cooling_down`.
- Do not start a second URL poll after wait (`wait_for_url`).
- Blue / Replicate use their own pollers (they already sleep first). They must not GET Parascene to learn that status.
- Wait cadence does not fix thumb / newest-sync GET storms. Those share the same rate gate.

Skip wait when

- Create JSON already has **output** media of the expected type, or failed / error / cancelled.
- Resume / Try again: check local catalog first. If the **output file** is already there, ingest. Do not apply create-silence.

Silence (fresh in-flight create only)

- No GET. Cancel checks and local-output checks are allowed.
- Image: 8s, then first GET.
- Video: 45s, then first GET. Fast model errors sit until that GET. Do not poll sooner to “catch” them.

Then keep a fixed interval until done. Image 8s. Video 15s. Do not speed up for a `processing` status we do not actually see. Clip duration does not change this.

Timeout starts at create (or resume attach), not at first GET. Image 10 min. Video 20 min. Callers may pass shorter. Cadence saves the rate gate; a short timeout does not.

Done

- Image: output image URL, or local image file, or failed / cancelled.
- Video: output **video** URL or local **video** file, or failed / cancelled.
- Not done: `thumbnail_url` / `fit_thumbnail_url`, input still, poster, local thumb-only. `media_url()` today is too broad for wait.
- Empty status is still in-flight. Do not wait for status to leave `creating` if the **output** is already there.

`media_url()` is still used to resolve stills for i2v; wait uses `output_media_url` instead.
