# Plan: Ephemeral frame CDN

Short-term. Desktop extracts the still. Parascene mints Blue ephemeral CDN storage. The JPEG never becomes a Creation and never enters the project Images cabinet.

This replaces “put the video on CDN and extract there.” Keep local last-visible-frame extract (`ffmpeg.rs`). Do not add `?t=` / last-frame to CDK yet. See [PLAN-blue-cdn-frames.md](./PLAN-blue-cdn-frames.md).

Same door as audio CDN. Desktop does not hold the Blue API key. Bytes do not go through Vercel. No ticking Blue URLs in client JSON or Creation list rows.

## Flow

Desktop ffmpeg still (timeline source time — trim / loop / ping-pong already applied).

`POST /api/create/ephemeral-still/start` → upload URL + ticket.

Client PUT jpeg to Blue (possession URL).

`POST /api/create/ephemeral-still/finalize` → `{ still_url }` (stable Parascene path).

Generate `input_images` uses `still_url`. Job mints a Blue fetch URL for the model only.

`GET still_url` (signed-in owner) → 302 to a short-lived Blue fetch. Form preview can use this.

Object is unpinned. CDN ephemeral TTL (~24h) is enough for generate. No `prsn_created_images` row.

## Who sends what

- Hosted project still, fit: existing Creation URL. Unchanged.
- Video neighbor extract (and other throwaway derived jpegs we choose later): ephemeral still. `creationId` null. Do not file Images.
- Blue Direct / Replicate: local extract. Unchanged.

## Do not

- `uploadImage` + Images group for a timeline extract.
- Pin the object (that is durable audio).
- Put `o_…` or ticking `/cdn/…` in desktop state.
- Touch `/api/files` or the Comfy sweeper.
- Add video-on-CDN frame extract in this pass.

## Repos

- `parascene` — start / finalize / GET / job rewrite
- this repo — plan send `upload_ephemeral`, PUT helper, Generate wiring
- `parascene-provider-local` — no new extract; existing upload/fetch/TTL

## Done when

- Editor first/last from a previous clip does not add an Images member.
- Parascene I2V / FLF still runs (job can GET the jpeg).
- Form FIRST/LAST can show the still URL (not a leftover `local-*`).
- Tests: ticket HMAC; video-still plan is ephemeral; job rewrites `still_url` to a Blue fetch.
