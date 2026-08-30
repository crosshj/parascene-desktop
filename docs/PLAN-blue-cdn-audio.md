# Plan: Parascene CDN + audio Creations

Blue is three things on one machine. Do not merge them.

- Generate server — jobs/methods. Product (`server_id` 6) and Direct-to-Blue both use this. Untouched.
- Direct-to-Blue staging — `/api/files`. User creds, Comfy input, ~24h TTL. Do not touch. No `so`/`du`, no public GET, no Creations.
- Parascene CDN — `https://blue.parascene.com/cdn/...` (not `/api/cdn`). New disk, ffmpeg for windows and `?cover=1`.

If a change would touch `files.js`, the Comfy input sweeper, or desktop `blue/client.rs` upload, it is the wrong door.

Two product problems stay distinct:

- Generate input — stranger GET of a time-window URL. Phases 1–2 done; joined in 5.
- Owned song — durable audio Creation. Phase 3 on www; 4 is desktop.

Suno scrape stays dropped. Library clips (`prsn_audio_clips`) stay the throwaway A2V pipe until phase 5. Vocals and lyrics stay on the desktop project (Lab), not on the Creation.

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

## Phase 3 — www audio Creations [code in, prod validate next]

Import Media: original Suno/YouTube URL block stays on top. Second section is local file (host, embedded cover, 50 MB). Modal stays open during import; closes only on success.

Ingest: `POST /api/create/import-audio/start` → browser PUT to Blue → `POST .../finalize`. HMAC ticket ties start→finalize to the same user. Insert `prsn_created_images` with `media_type: "audio"`, `meta.audio = { cdn_id, duration, content_type, filename }`.

Playback: custom hosted player (315×100), not native `<audio controls>`. Download is in the creation three-dots menu, not on the player. Client uses `GET .../audio?format=json` then fetches Blue with `credentials: "omit"` (following the 302 with cookies CORS-fails).

Admin permanent delete (`?permanent=1`) calls `deleteCdnObjectBestEffort`. Owner delete is soft; CDN stays. Cleanup is best-effort: Blue miss still deletes the row.

Local looks good. Pushing www + Blue to prod. Still need to prove:

- Import, play, three-dots download on parascene.com.
- Soft-delete leaves CDN; admin hard-delete removes the object.

Key www files: `api_routes/utils/blueCdn.js`, `importAudioFileCreation.js`, `create.js`, `public/shared/importAudioFile.js`, `importSunoModal.js`, `public/pages/creation-detail.js`. Blue CORS: `parascene-provider-local/server/lib/http.js` (open CORS on possession `/cdn` URLs; `setHeader` before `writeHead`).

## Phase 4 — desktop [not started]

Product path only. Direct-to-Blue keeps `/api/files`. No shared helper that treats them as one store.

- Create: same as site — ask Parascene, PUT to minted upload URL. Desktop does not hold the Blue API key on this path.
- Sync: `mapRemoteCreation` uses Parascene `audio_url`, follow 302, save bytes. Do not persist a Blue ephemeral URL. Cover stays thumb. Skip cover-only Suno (`isCoverOnlyCloudAv`).
- Editor / Lab: treat synced audio Creations like local audio. Generate can still slice and POST clips until phase 5.

## Phase 5 — product create [not started]

Desktop sends `audio_creation_id` + start + duration. Parascene puts a Parascene audio URL (with range) on `input_audio_urls`. GET 302s to a Blue window. Desktop does not build CDN query params or call `/api/files` on this path.

When this works, product A2V can stop uploading throwaway clips for Creation-backed songs. Direct-to-Blue may still POST slices to `/api/files`.

## Do not

- Touch `/api/files` or the Comfy input sweeper.
- POST song bytes through Vercel.
- Put Blue object ids or ticking CDN URLs in client JSON.
- Fold Direct-to-Blue into this.
- Put vocals/lyrics on the www Creation (Lab/project only).
- Revive Suno scrape.
