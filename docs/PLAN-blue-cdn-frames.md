# Plan: Blue CDN video frames

Short-term: do not add video still-at-time on CDN. Desktop extracts; Parascene stores the jpeg on ephemeral Blue CDN. See [PLAN-ephemeral-frame-cdn.md](./PLAN-ephemeral-frame-cdn.md).

If CDN later grows a still-at-time (or last-frame) query, port the desktop extract rules. Do not invent a second seek recipe.

CDN lives in `parascene-provider-local` (`server/lib/cdn-ffmpeg.js`, CDK). Today `?cover=1` is first video/art frame only. `so`/`du` is audio window (`-vn`). Video stills are new.

Source of truth: `src-tauri/src/library/ffmpeg.rs` (`extract_video_jpeg`). Timeline mapping stays on the client (`addAssetStartFrame.ts`, `timelineCompose.ts`). CDN gets a source time or an explicit last-frame sentinel — not a timeline end.

The bug we already hit: clip 8.9s, file probe 8.90s, seek to `duration - 0.05` with `-frames:v 1` → empty JPEG. Container duration (audio pad, rounding) often outlasts the last video packet. The last frame shown on the timeline was there; the timestamp was past it.

Must port
- Last visible frame = last decoded frame at or before the requested source time (trim / speed / loop / ping-pong already applied by the client).
- Untrimmed (time at/near file duration, or last-frame sentinel): rewind ~1s, `-update 1`, decode to EOF. A non-empty JPEG is success even if ffmpeg exits non-zero at EOF.
- Trimmed / looped mid-file time: stop at that time. Never walk to file EOF.
- Do not clamp the requested time down by 50ms. That skips the last shown frames and lands in the empty gap after the last packet.
- Do not treat empty JPEG as success just because ffmpeg exited 0.
- `format=yuvj420p` for JPEG full-range (mjpeg -22).
- Ignore 0-byte cache hits.
- First frame of a neighbor is the clip in-point, not file t=0 if trimmed.
- Image / still sources: do not run video extract.
- `?cover=1` stays first-frame/artwork. New query is separate (`t` / last).

Client still owns
- Half-open clip: last shown instant is just before `endSec`.
- `clipSourceSec` for trim, speed, loop, ping-pong. A 9s file on a 16.6s looped clip must request ~7.6s, not 16.6s.
- Reverse: extract from the reversed source.
- Parascene path: extract is upload transport; durable input is a Creation. See [GUIDE-generation-inputs-provenance.md](./GUIDE-generation-inputs-provenance.md).

Do not
- Copy `duration - 0.05` + `-frames:v 1` into CDK.
- Put Blue object ids or ticking CDN URLs in client JSON (same as audio CDN).
- Fold this into `/api/files` or the Comfy input sweeper.

Done when
- Untrimmed 8.9s video (container slightly longer than last packet) returns the last shown still, not 404 / empty.
- A mid-file out-point (trim or loop) returns that time, not file EOF.
- Tests in `parascene-provider-local` cover both cases (desktop already has these in `ffmpeg.rs`).
