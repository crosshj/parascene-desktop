# Plan — Direct integration with Parascene Blue

Placeholder plan for connecting **parascene-desktop** directly to the Parascene Blue generation server (`https://blue.parascene.com`), separate from the public www OAuth / product API path.

## What we know so far

- **Base:** `https://blue.parascene.com`
- **Capabilities probe:** `GET /api` returns operational status, generation methods, field schemas, capability matrix, and retention TTLs.
- **Auth (local/dev style observed in browser):**
  - `Authorization: Bearer <token>` (currently `parascene-local-dev-token`)
  - Cloudflare Access service token headers: `cf-access-client-id`, `cf-access-client-secret`
  - Session cookies: `ps_session`, `cf_clearance`, `CF_Authorization` (JWTs expire; refresh from browser when needed)
- **Local secrets:** stored in repo-root `.env` (gitignored). Keys:
  - `PARASCENE_BLUE_BASE_URL` / `PARASCENE_BLUE_API_URL`
  - `PARASCENE_BLUE_API_TOKEN`
  - `PARASCENE_BLUE_CF_ACCESS_CLIENT_ID` / `PARASCENE_BLUE_CF_ACCESS_CLIENT_SECRET`
  - `PARASCENE_BLUE_COOKIE`
- **Checked-in reference snapshot:** [parascene-blue-api-capabilities.json](./parascene-blue-api-capabilities.json) — live `GET /api` response captured for planning.

## Methods exposed by Blue (from snapshot)

`text2image`, `image2image`, `text2video`, `image2video`, `audio2video`, `video2video`, `reference2video` — each async, with model/option fields and credits.

## Intended use (TBD)

- Use Blue as a direct generation backend for desktop workflows that should not round-trip through www-only product surfaces.
- Agents / tooling can re-read `GET /api` (via `.env` creds) when we need current server capability info.
- Align desktop generation UI with Blue’s method/field contract rather than inventing a parallel schema.

## Open / not decided yet

- How desktop auth should work long-term (service token vs user session vs OAuth) vs the browser cookie bag used for this first probe
- Whether jobs create Parascene Creations or return media only (see also [PLAN-parascene-generation.md](./PLAN-parascene-generation.md))
- Wiring into existing SDK / capabilities modules
- Refresh / rotation process for CF Access + session cookies

## Next steps (when we pick this up)

1. Confirm which Blue endpoints desktop will call beyond `GET /api` (e.g. generate, job status, file upload).
2. Sketch a thin client that loads credentials from `.env` in local/dev only.
3. Map Blue methods → desktop generation surfaces (Hook, timeline fill, storyboard, etc.).
4. Refresh the capabilities snapshot when the server contract changes.
