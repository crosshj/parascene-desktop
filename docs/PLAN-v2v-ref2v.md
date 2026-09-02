# Plan: V2V and Ref2V

Ship Video to Video and Refs to Video on Generate across Parascene, Direct to Blue, and Replicate. MiniMax H3 is the first Refs to Video model where the live contract allows it.

Live caps (2026-09-02)

- Blue `GET /api` and Parascene server 6 now match: `video2video` (ltx_ic_lora, wan_animate, bernini_r_v2v, wan_scail*) and `reference2video` (minimax_r2v, ltx_ingredients). H3 is `minimax_t2v` / `minimax_i2v` / `minimax_r2v` — not a `video2video` model.
- Refresh: `npx tsx scripts/probe-parascene-servers.mts` and `npx tsx scripts/probe-blue-api.mts`.
- Replicate `minimax/h3` is on replicate.com. Lab search is a local crawl cache. Check New stops at recent version timestamps, so a slug published weeks ago never appears in `/v1/models` pages we scan. Do not inject it into the catalog unless that list (or an explicit user Fetch of that slug) returned it. Live OpenAPI inputs: `prompt`, `first_frame_image`, `last_frame_image`, `reference_image_urls`, `reference_video_urls`, `reference_audio_urls`, `duration`, `resolution`, `ratio`. Video-fill heuristics look for `start_image` / `video` / `reference_video`, so this schema would stay hidden from timeline fill even after Enable until Generate maps those fields. Do not fake H3 with Hailuo 2.3.

First-ship ids

- Refs to Video: `minimax_r2v` (Parascene + Direct to Blue)
- Video to Video: `bernini_r_v2v` default (video + prompt). Character still required for wan_animate / ltx_ic_lora / wan_scail*.
- Replicate: Coming soon (written reason above)

Work

- Shared typed ref trays (pictures / videos / audio) plus driving-video source window
- Send: Parascene = Creation URLs; Blue = `/api/files`; Replicate = local files (when wired)
- Flip Coming soon only where the matrix is live
- Keep two intents. Do not stuff these into timeline-fill continuity modes.

Done when

- Direct to Blue and Parascene leave Coming soon for both intents, attach the right refs, and land a clip
- Replicate is live on H3 with the same form, or still Coming soon with the catalog reason above
