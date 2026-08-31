# Guide: Generate source images

How a project image is sent to a model. Code: `planGenerateSourceImage` in `src/layouts/editor/generateSourceImage.ts`. Related: [GUIDE-generation-inputs-provenance.md](./GUIDE-generation-inputs-provenance.md), [GUIDE-generate-wait.md](./GUIDE-generate-wait.md).

Ask four questions. Then follow the matching case. Framing (fit vs fill/stretch) is a modifier on hosted stills.

- Hosted: the pick is already a Parascene image Creation with a public image URL
- Grouped: that Creation is the Images cover or a `source_creation_ids` member
- Target: `parascene` | `blue_direct` | `replicate`
- Video still: the pixels are a frame extracted from a project video, not an image asset

Hard rules (every case)

- Never regroup a source. Already-filed members look deleted as standalone rows. Resending them is `Cannot group deleted creations`.
- Generate does not file existing project stills into Images. Filing is only for a still Creation this run just uploaded.
- A video is not an image URL. Do not pass a video Creation URL as `input_images`.
- Blue / Replicate never create or group Parascene stills.

Framing modifier

- Fit + hosted still: pixels already match. Use the hosted URL on Parascene.
- Fill / stretch: pixels changed. Treat as a new still (upload on Parascene, local file on Blue/Replicate).
- Video still: always new pixels. Same as fill/stretch.

Parascene target

- Hosted still, fit, grouped or not: send existing URL. Durable id = that Creation. Do not group. Do not upload a clone.
- Hosted still, fill/stretch, grouped or not: bake JPEG, upload new Creation, append only the new id to Images. Durable id = new Creation. Do not re-send the original member.
- Not hosted (local-only image): upload new Creation, append the new id. Durable id = new Creation.
- Video still (video may be hosted / in Videos): extract locally, upload to Parascene ephemeral Blue CDN (`still_url`). Do not create a still Creation. Do not file Images. Durable input = that `still_url`. Drop the temp extract from project membership. See [PLAN-ephemeral-frame-cdn.md](./PLAN-ephemeral-frame-cdn.md).

Blue / Replicate target

- Image asset, fit: send local file. Durable id = that asset. Do not upload. Do not group.
- Image asset, fill/stretch: send the local framed file. Durable id = that extract. Do not upload. Do not group.
- Video still: send the local extract. Durable id = that extract (keep it). Do not upload. Do not group.
- Hosted vs grouped does not change the send path. Local bytes only.

Grouped vs not

- Same send path either way. Grouped only makes regroup fatal. Ungrouped still must not be filed by Generate — that is not “add to cabinet.”

Output video (Parascene)

- New video files into the Videos cabinet. File the **cover** into the project folder (`folder_items`).
- Do not file the member as a loose Library tile. Do not leave the cover at Library root.
- Assets explodes members from the cover. Library inside the project folder shows the cover.
- After create, wait per [GUIDE-generate-wait.md](./GUIDE-generate-wait.md). Do not file until the **video** output exists.
