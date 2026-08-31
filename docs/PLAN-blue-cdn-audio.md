# Plan: Parascene CDN + audio Creations

Blue is three things on one machine. Do not merge them.

- Generate server — jobs/methods. Product (`server_id` 6) and Direct-to-Blue both use this. Untouched.
- Direct-to-Blue staging — `/api/files`. User creds, Comfy input, ~24h TTL. Do not touch. No `so`/`du`, no public GET, no Creations.
- Parascene CDN — `https://blue.parascene.com/cdn/...` (not `/api/cdn`). New disk, ffmpeg for windows and `?cover=1`.

If a change would touch `files.js`, the Comfy input sweeper, or desktop `blue/client.rs` upload, it is the wrong door.

Two product problems stay distinct:

- Generate input — stranger GET of a time-window URL. Phases 1–2 done; joined in 5.
- Owned song — durable audio Creation. Phase 3 on www; 4 is desktop.

Suno scrape stays dropped. Library clips (`prsn_audio_clips`) stay the throwaway pipe for vocals and local-only songs. Full-mix CDN songs skip clip upload. Vocals and lyrics stay on the desktop project (Lab), not on the Creation.

Repos: `parascene-provider-local` (CDN), `parascene` (www), this repo (desktop + probe scripts). www validation notes also in `../parascene/_docs/TODO_PLAN_audio_cdn_hard_delete.md`.

## Locked

Mint (upload URL, pin, delete, fetch/window): Bearer same as `/api` (`PARASCENE_API_KEY`).

Client links (PUT upload, GET fetch, `?so&du`, `?cover=1`): unauthed, short-lived. Possession of the URL is the gate. Cloudflare Access stays on mint + `/api/files`; ephemeral `/cdn` is bypassed in prod.

Object id (`o_` + 24 hex) is server-only. `GET /cdn/{object_id}` → 403. Never put ticking Blue URLs in list JSON.

Client-visible `audio_url` is a stable Parascene path. GET that path → auth → mint → 302 to Blue. Bytes never stream through Vercel.

Cover: same ephemeral fetch URL + `?cover=1` → jpeg. CDN 404 → placeholder. No ID3 in the browser.

Pin on finalize so abandoned PUTs expire.

## Phase 1 — Blue CDN [done]

Deployed and proved: mint upload, unauthed PUT/GET, `so`/`du`, `?cover=1`, pin, delete. Pinned store is not Comfy input and is not swept by input TTL.

## Phase 2 — stranger GET [done]

Replicate `openai/whisper` GETs a minted window URL (~$0.0025). Not A2V, not `/api/files`. Fail if logs show 401 / CF Access.

## Phase 3 — www audio Creations [done enough; skip remaining validate]

Import Media: original Suno/YouTube URL block stays on top. Second section is local file (host, embedded cover, 50 MB). Modal stays open during import; closes only on success.

Ingest: `POST /api/create/import-audio/start` → browser PUT to Blue → `POST .../finalize`. HMAC ticket ties start→finalize to the same user. Insert `prsn_created_images` with `media_type: "audio"`, `meta.audio = { cdn_id, duration, content_type, filename }`.

Playback: custom hosted player (315×100), not native `<audio controls>`. Download is in the creation three-dots menu, not on the player. Client uses `GET .../audio?format=json` then fetches Blue with `credentials: "omit"` (following the 302 with cookies CORS-fails).

Admin permanent delete (`?permanent=1`) calls `deleteCdnObjectBestEffort`. Owner delete is soft; CDN stays. Cleanup is best-effort: Blue miss still deletes the row.

Prod proved for 27140: CDN ingest meta, ranged mint via Parascene `/audio?so&du`, unauthed Blue GET, Whisper on a 9s window. Soft/hard-delete and www UI play/download — skip for now.

Key www files: `api_routes/utils/blueCdn.js`, `importAudioFileCreation.js`, `create.js`, `public/shared/importAudioFile.js`, `importSunoModal.js`, `public/pages/creation-detail.js`. Blue CORS: `parascene-provider-local/server/lib/http.js` (open CORS on possession `/cdn` URLs; `setHeader` before `writeHead`).

## Phase 4 — desktop [sync done; create skipped]

Product path only. Direct-to-Blue keeps `/api/files`. No shared helper that treats them as one store.

- Create: same as site — ask Parascene, PUT to minted upload URL. Desktop does not hold the Blue API key on this path. Skip for now (www import is enough).
- Sync: `mapRemoteCreation` / Rust `map_remote_creation_json` prefer Parascene `audio_url` as `remoteUrl`. Cover stays on `url` / thumbs. Cover-only Suno (no `audio_url`) still maps to image remote and skips download. Download follows auth → 302 → Blue; do not persist a Blue ephemeral URL. Done; lightbox re-reads catalog on open.
- Editor / Lab: treat synced audio Creations like local audio.

## Phase 5 — product create [done]

Any client (desktop included) sends `audio_creation_id` + `audio_start_sec` + `audio_duration_sec`. Desktop does not mint Blue URLs.

Parascene create validates the Creation + range. Fail the request with `code: audio_resolve_failed` and a clear `message` if it cannot. Job mints a Blue CDN window and sends only `input_audio_urls` (or other `audio_url` / `audio_url_array` fields). Blue never sees the Creation id.

Vocals / local-only still slice + `audio_clip_id`. Direct-to-Blue may still POST slices to `/api/files`.

A2V source audio is full mix, or vocals when lyrics exist in range. No None option.

Proved: Editor A2V on CDN song 27140 (full mix, no `/api/audio-clips/record`).

## Do not

- Touch `/api/files` or the Comfy input sweeper.
- POST song bytes through Vercel.
- Put Blue object ids or ticking CDN URLs in client JSON.
- Fold Direct-to-Blue into this.
- Put vocals/lyrics on the www Creation (Lab/project only).
- Revive Suno scrape.

## Later — video frame stills

Short-term is ephemeral jpeg storage, not video-on-CDN extract. See [PLAN-ephemeral-frame-cdn.md](./PLAN-ephemeral-frame-cdn.md). If CDK later grows `?t=` / last-frame, port desktop rules — [PLAN-blue-cdn-frames.md](./PLAN-blue-cdn-frames.md).
