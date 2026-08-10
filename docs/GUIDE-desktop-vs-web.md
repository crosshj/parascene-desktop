# Guide — Desktop vs web

**Cite this doc** when choosing which product surface, generation lane, or backend path a feature should live on.

## One-sentence strategy

**Parascene web** is the social product; **Parascene Desktop** is the local, pay-your-own-compute / insider-Blue studio that makes outside-web content — and Blue direct exists so that studio does not wait on (or bloat) the web stack.

## Web

**Settled role:** social destination and softer landing. Browser context, account identity, credits, Creations, discovery/belonging.

| Trait | Implication |
| --- | --- |
| Social / browser | Constrained uploads, session UX, Creation-backed flows |
| Less bleeding-edge audience | Do not push every new Blue method/model into web create UI |
| Credits model | Familiar monetization; gen subset that fits product + DB |
| Audience signal | Free users often are not converting; paying users are not asking for more advanced Blue on web |

**Do not** treat web feature parity with Blue’s full `GET /api` contract as a prerequisite for desktop.

## Desktop

**Settled role:** maker studio. Local-first video work with freedom and control. Content is meant to **survive outside** the app and (hopefully) go viral — driving people back to web.

| Trait | Implication |
| --- | --- |
| Filesystem, FFmpeg, long jobs | Large video/audio, timelines, local library without browser limits |
| Exportable quality | Optimize for finished pieces, not in-app social surfaces |
| BYO / insider compute | Replicate bill; Blue-direct creds without web credits gating that lane |
| Unfair advantages | Direct Blue `/api/files`, full method set (incl. advanced video), no web create-UI tax |

### Assumptions desktop makes

- Working media is **local-first**; Parascene cloud is optional sync/publish, not the scratch disk
- Users can bring (or be granted) their own compute economics — Replicate token and/or Blue-direct credentials
- Insiders tolerate sharper tools and credential setup for power
- New Blue surface ships on desktop first when web would otherwise need create UI, hosting, or Creation plumbing

## Audience economics → channel decision

Web free users not converting + paying users not asking for more is **not** a reason to stall advanced gen. It is a reason to put bleeding-edge Blue on **desktop** (motivated makers) and keep web on a safer, credits-shaped subset.

Desktop makers produce culture that markets the web product.

## Generation lanes on desktop

Three lanes. Labels in the UI must match the lane, not legacy internal ids.

| Lane | UI label | Backend | Billing / access | Media landing |
| --- | --- | --- | --- | --- |
| Product path | **Parascene** | www OAuth → create API (`server_id: 6` today) → Creation → sync | **Credits-first** (familiar for people coming from web); not bleeding-edge | Parascene Creation + local library ingest |
| Blue direct | **Parascene Blue** | `https://blue.parascene.com` (upload, generate, poll) | User-supplied Blue credentials; gated like Replicate | Local library import only (no Creation required) |
| Replicate direct | **Replicate** | Replicate API | User API token in Settings (keychain) | Local library import |

**Settled naming:** Do **not** call the product/Creation path “Parascene Blue.” That name is reserved for direct Blue. Stable code ids (e.g. `parascene_blue`) may remain legacy until renamed; user-facing copy must be honest.

**Credits-first on desktop:** Keep a Parascene credits story for web migrants and account-linked gen. That lane stays the non-bleeding-edge default. Blue-direct and Replicate are the power lanes.

## Credential gates

**Settled pattern:** Blue-direct and Replicate are both unavailable until the user configures credentials in Settings (status / set / clear). Show a clear CTA — same product idea as the existing Replicate token block in Settings.

- Replicate: token in system keychain (already shipped; Lab models + Predictions)
- Blue-direct: user-enterable Blue creds (API token + CF Access client id/secret; base URL hardcoded to `https://blue.parascene.com`) — Settings pattern like Replicate; optional `PARASCENE_BLUE_*` env fallback; Lab methods + Predictions shipped — details in the Blue-direct plan

Do not silently fall back Blue-direct → product path; that muddies labels and media.

## Why Blue direct (philosophy → tech)

1. **Skip the middleman** — desktop features should not wait on web create UI, Parascene-hosted intermediates, or Creation DB rows.
2. **Use what Blue already supports** — e.g. `/api/files` uploads and advanced video (`video2video`, `reference2video`, newer models) that web does not fully surface.
3. **Keep Parascene clean** — avoid stuffing the social/product DB and storage with desktop scratch media.
4. **Local + remote GPUs** — marry local projects with Blue compute without round-tripping every frame through www.

## Settled vs open

| Idea | Status |
| --- | --- |
| Web = social / softer; desktop = studio / export / viral → web | **Settled** |
| Desktop eases web/DB load; not everything in cloud | **Settled** |
| Product path labeled Parascene; direct path labeled Parascene Blue | **Settled** |
| Credits-first product lane coexists with BYO Replicate + Blue-direct | **Settled** |
| Gate Blue-direct and Replicate on Settings credentials | **Settled** |
| Blue-direct gens land local-only (no Creation) for the Lab proof | **Settled — Lab shipped**; Editor promote path / Phase B still open |
| Long-term Blue auth (service token vs session vs OAuth) | **Open** |
| When/whether local gens promote to Parascene Creations | **Open** |

## Decision guide (for future work)

1. Is this social, account, credits, or soft landing? → **Web** (or desktop product path only).
2. Is this advanced Blue, large local media, or “don’t bloat Creations”? → **Desktop Blue-direct** (or Replicate), not a web create-UI project.
3. Is the user coming from web and expecting credits? → **Parascene** product lane on desktop.
4. Does the feature need Blue’s full method/upload contract? → **Parascene Blue** direct; cite the Blue proof plan for implementation order.
