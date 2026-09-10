# Guide — Generation lanes

Three desktop lanes. Do not conflate them. Live vs coming-soon: [STATUS-new-asset.md](./STATUS-new-asset.md). Web vs desktop: [GUIDE-desktop-vs-web.md](./GUIDE-desktop-vs-web.md). Inputs: [GUIDE-generation-inputs-provenance.md](./GUIDE-generation-inputs-provenance.md).

Capabilities snapshot: [parascene-blue-api-capabilities.json](./parascene-blue-api-capabilities.json). Refresh when the Blue contract changes (`npx tsx scripts/probe-blue-api.mts`).

## Lanes

| Lane | UI label | Pipe | Output |
| --- | --- | --- | --- |
| Product | **Parascene** | OAuth → create `server_id: 6` → Creation → ingest | Catalog + sync. Credits. Never call this “Blue.” |
| Blue direct | **Direct to Blue** | Settings creds → Blue HTTP (`/api/files` + jobs) → local import | Local-only. No Creation row. |
| Replicate | **Replicate** | Settings token → Replicate → local import | Local-only. No Creation row. |

Stable code ids (e.g. `parascene_blue` on the product path) may stay until renamed. User-facing copy must not call the Creation path “Blue.”

Blue base is `https://blue.parascene.com`. Auth is Bearer + Cloudflare Access headers from Settings (keychain). Optional `PARASCENE_BLUE_*` env fallback when Settings is empty. Do not fall back to the Parascene product path when Blue creds are missing.

## Why two Blue doors

Desktop is where bleeding-edge Blue lands. Web stays social / credits. Blue `/api/files` and advanced video (`video2video`, `reference2video`) skip www create UI and keep scratch media off the Parascene DB.

Lab **Parascene Blue methods** + **Predictions** stay the capabilities explorer. Generate is intent-first (modality → server). **Direct to Blue** is the Generate server for that lane.

## Do not

- Label the credits / Creation path “Blue.”
- Stuff V2V / Refs into timeline-fill continuity modes.
- Wait on web create to grow video-ref fields.
- Promote a local Blue/Replicate gen to a Creation as a hidden fallback. That is an explicit future operation.
- Touch `/api/files` when the job is Parascene CDN audio or ephemeral stills. Different door: [GUIDE-blue-cdn-audio.md](./GUIDE-blue-cdn-audio.md).

## Open

- Long-term Blue auth (token vs session vs OAuth)
- Whether/when local gens promote to Parascene Creations
- Replicate V2V / Refs (`minimax/h3` missing from the Lab crawl) — [PLAN-v2v-ref2v.md](./PLAN-v2v-ref2v.md)
- Generate video to Assets; place stills on the timeline — [STATUS-new-asset.md](./STATUS-new-asset.md)
