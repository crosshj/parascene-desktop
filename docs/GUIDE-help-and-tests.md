# Guide: Help, tests, and the agent

Read this before Help, integration tests, the agent API, leftover-docs work, or teardown. Other plans are details. This file is the strategy and the scoreboard.

The running app is behavioral truth. Tests verify it. Help describes it. The local agent API is the shared machine-readable surface. A user-visible workflow gets a live journey test and an article when it is a first-run job. Identity after generate / Remove / Delete / Sync is a second track: same object, both sides, not Help media.

Do not teleport the app into a cooked state. Setup is `invoke` on the page a person would use. Do not invent a quiet agent path. Help never mentions tests, fixtures, or agent actions.

# Account beginning state

`@awesome` is the cheaper already-signed-in test user. Before and after every suite the Library is one unpublished 1:1 still: id `28006`, neon green aardvark, the account avatar. That tile is the new-user picture. Never `cloud.delete` it. Never treat it as leftover. Teardown fails if it is gone. After tests, Sync is idle and `folder_pending_ops` has no `agent-test-*` junk.

Leftover means this-run / `agent-test-*` only. Cloud leftovers on this account are a product bug. Wiping the seed is a worse bug.

# Two tracks

Help and journeys (01–07, Help HTML). What a new user does: sign in, glance at Library (the seed tile), New project, generate the goblin, Audio to Video, models, Sync, projects, folders. Articles under `public/help/`. Live shots only where the suite writes them (05–07). This is the 1.1.58 leftover track.

Same object (08–11). One Creation id locally and on Parascene after generate, Sync, Remove, Delete, remount. Cheap stills. Not the goblin. Not Help screenshots. Product bugs found here are real; they are not a substitute for the leftover Help map.

If the job is leftover docs after 1.1.58, stay on the Help/journey track. Start with the map below. Do not open another identity suite unless the user asked for identity.

# Feature map

A change to a row names the test and the article. Empty test or “static shots” is leftover, not a free pass to skip Help.

- Getting started — `getting-started.html` — no live test (already signed in) — static first-run shots
- Generate an image — `generate.html` — 05 — live shots from 05
- Generate speech and music — `generate-audio.html` — 12 — live shots from 12 (own project; two speakers + background on A1/A2)
- Generate a video with audio — `audio.html` — 06 — live shots from 06 (same project, same goblin)
- Image models — `image-models.html` — 07 — stills from 07. Edit / Kontext named, no thumbs
- Video models — `video-models.html` — none — names only
- This computer and the cloud — `local-and-cloud.html` — 08–11 prove the model; no Help shots
- Sync — `sync.html` — 02 — static first-run
- Projects — `projects.html` — 03 — static first-run
- Folders — `folders.html` — 04 — no dedicated shots
- Settings — `settings.html` — none — one static shot
- Local tools — `tools.html` — none — no shots
- Assets Remove / Delete — no Help page — 10 (last Images proven; last Videos needs a clip)

# Where we are (2026-09-07)

Phases 0–3 shipped in 1.1.58: account isolation, agent API, suites 01–07, in-app Help.

Help IA since then (small leftover slice): Overview removed. Getting started is first-run only. New topic `local-and-cloud.html`. Voice rule updated. Not the Phase 4 map, not first-run shot regen, not Settings/tools tests.

Same-object track since then (the away work): `library.lookup` / `cloud.lookup` inspect. Shared Assets Remove/Delete. Suites 08–11 written and run. Sync newest no longer prunes grouped members. Last Images Remove no longer bounces. Folder sync drops stale creates and dead unfile-moves; teardown flushes `agent-test-*` pending ops. Seed `28006` was wrongly deleted once; it is protected now.

Still open on leftover after 1.1.58: follow-the-API help audit, first-run screenshot regen (login, Library with seed tile, Sync, Projects, Director, Editor, Settings), video-models journey, Edit/Kontext thumbs, next goal articles (T2V / I2V / V2V / Refs, timeline edit, export), Settings / tools / failures tests, release audit. Phase 5 (Help is part of feature done) waits on using this map, not on more identity suites.

Still open on product from the identity track: last Videos member Remove (needs A2V). Folder conflicts / two-machine later.

# How to work

Live Parascene. Already signed in. Be gentle. Cheap generate for 08–11 (`sd15` lofi). Help goblin is 05–07 only.

`npm test` is unit. `npm run test:integration` is 01–12 against `npm run dev`. One integration file at a time. Do not run 05–07 while iterating 08–11. Suite 12 needs live Parascene `replicateSpeech` / `replicateMusic` on server 1 (provider deploy + server refresh).

Teardown: this-run ids, `agent-test-*` title/path, this-run prompts. Then `sync.folders` with `dropTitleContains: agent-test-`. Then assert `28006` is still in the catalog.

Phase 5 later: change a user-visible workflow → run the matching suite → verify that article → update copy or shots only if the UI the article names changed. Do not review the whole Help corpus. Do not touch tests or docs only because an implementation file changed.

# Pointers

- Agent how-to: [dev/agent-interface.md](./dev/agent-interface.md)
- Original 0–5 requirements: [PLAN_LocalAgentInterface_IntegrationTesting_DocumentationPlan.md](./PLAN_LocalAgentInterface_IntegrationTesting_DocumentationPlan.md)
- Same-object track: [PLAN-remote-local-consistency.md](./PLAN-remote-local-consistency.md)
- Last cabinet member: [PLAN-last-cabinet-member-remove.md](./PLAN-last-cabinet-member-remove.md)
- Help voice: `.cursor/rules/help-walkthrough-voice.mdc`
- Seed ids: `src/library/seedLibraryCreations.ts`
