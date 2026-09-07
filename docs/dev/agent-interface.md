# Dev agent interface

Strategy: [GUIDE-help-and-tests.md](../GUIDE-help-and-tests.md). This file is enable, connect, and the action list.

Local HTTP API on the running `tauri dev` app. Debug builds only. Not compiled into release.

# Integration tests

`npm test` never runs these. From the repo root, with `npm run dev` already up:

```bash
npm run test:integration
```

Files live in `integration/*.integration.test.*`, numbered so they run in order: `01` connect, `02` sync, `03` project, `04` folder, `05` generate, `06` audio-to-video, `07` image models, `08` identity, `09` local-only, `10` Assets Remove/Delete, `11` thumbs/media rows. They talk to the live loopback API only. One file at a time.

`05` and `06` are one tree. `05` generates the Grok start still, publishes Help media, and leaves the project. `06` opens that same project, uses that same still, runs Audio to Video, publishes the clip, then tears down. Re-run `05` only if you will also re-run `06` — Help must show the same goblin on both pages.

`07` is a sibling: the same goblin prompt on every Parascene Text to Image model. It reuses the Grok still from `05` and publishes the rest to `public/help/desktop/media/models/`. Image-edit / Kontext models (need a source still) are listed on the Topics page without thumbs and are not generated. Help articles are a first-run walkthrough — they never mention tests.

`@awesome` beginning Library state is one unpublished 1:1 still: id `28006` (neon green aardvark — the account avatar). That tile must still be there after every suite. `cloud.delete` skips it. Teardown fails if it is gone.

# Enable / connect

Start the desktop app with `npm run dev`. When the Rust side is up it writes:

`~/Movies/Parascene/agent.json`

```json
{ "origin": "http://127.0.0.1:<port>", "token": "<uuid>", "pid": 123 }
```

All routes need `Authorization: Bearer <token>`. Loopback only.

```bash
ORIGIN=$(python3 -c "import json; print(json.load(open('$HOME/Movies/Parascene/agent.json'))['origin'])")
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/Movies/Parascene/agent.json'))['token'])")
curl -sS -H "Authorization: Bearer $TOKEN" "$ORIGIN/agent/v1/health"
curl -sS -H "Authorization: Bearer $TOKEN" "$ORIGIN/agent/v1/state?scope=auth"
curl -sS -H "Authorization: Bearer $TOKEN" "$ORIGIN/agent/v1/actions"
```

# Commands

- `GET /agent/v1/health`
- `GET /agent/v1/state?scope=auth|shell|projects|library|all`
- `GET /agent/v1/actions?scope=`
- `POST /agent/v1/invoke` `{ "action", "args" }`
- `POST /agent/v1/reset` — clear agent logs/errors; close the open project
- `GET /agent/v1/errors`
- `GET /agent/v1/logs`

State is compact. Not a screenshot, not a full dump.

`GET /agent/v1/state?scope=library` includes sync counts (`total`, `remote`, `lastSyncAt`, `withThumb`, `withMedia`) and `needsSync` (true when `lastSyncAt` is empty).

`GET /agent/v1/state?scope=window` is `{ width, height, maximized }` in logical pixels.

`GET /agent/v1/state?scope=shell` includes `primaryTab`, `librarySurface`, `mode`, `openProjectId`, `openProjectTitle`.

# Actions

Wired (need a signed-in session unless noted; UI must be up):

Navigation (no data change):

- `shell.show` `{ tab?, surface?, mode?, panel? }` — show a page. `tab` is `library` | `project`. `surface` is `creations` | `sync` (implies Library). `mode` is `director` | `editor` | `hook` | `lab` (implies Project; editor/hook/lab need an open project). `panel: "newAsset"` opens Editor New asset without generating.

Domain actions still land on the page a person would use. That is not the only way to get there — use `shell.show` to go to a page without mutating.

- `project.create` `{ title? }` — lands Director
- `project.open` `{ id, mode? }` — default Director; pass `mode: "editor"` to open in Editor
- `project.close` — Project chooser
- `project.delete` `{ id }` — Project chooser; leftover folder deleted when empty
- `folder.create` `{ title? }` — Library creations
- `folder.delete` `{ id }` — Library creations
- `generation.start` `{ prompt?, projectId?, model?, aspectRatio?, size? }` — lands Editor, then generates a still. Default `sd15: lofi_V2pre` (~0.1 credit). Walkthrough / Help still uses `xai/grok-imagine-image` and the shared goblin prompt. `size` is for models that reject aspect ratios (Recraft). Do not use this just to open Editor. Waits up to 12 minutes.
- `generation.a2v` `{ projectId?, stillId, audioId? | audioPath?, prompt?, durationSec?, generate?, form?, videoId? }` — lands Editor and drops the **full** spoken file on the audio lane. Default (`generate` omitted or true) then places a `durationSec` (default 9) LTX `ltx_a2v` / full-mix clip at the start and waits (up to 12 minutes). First-time Help shots: `generate: false` is audio-only (empty video lane), then `generate: false, form: true` shows the 9s placeholder with Audio to Video / `ltx_a2v` / full mix / start frame, then a real generate writes the clip. `generate: false` must not place a video clip. `generate: false, videoId` puts that finished clip on the video lane.
- `library.import` `{ paths, projectId? }` — copy local files into Library (and the project when `projectId` is set). No file dialog.
- `cloud.delete` `{ id?, imagesGroupId?, ids? }` — Library creations. Skips seed id `28006` (account avatar).
- `cloud.lookup` `{ id }` — GET one Parascene Creation. `found: false` with `status` 404/410 is a result, not an error. Grouped Images/Videos members often 404 here; the cover row still lists that id in `memberIds`.
- `library.lookup` `{ id?, ids?, titleContains?, pathContains?, promptContains? }` — no navigation (query only). Each found row includes origin (`local` | `parascene`), `localOnly`, `remoteUrl`, `localPath`, `localThumbPath`, `downloadState`, folder ids, group kind / member ids, and cabinet pointers (`images` | `videos` | `cover`). `titleContains` / `pathContains` / `promptContains` scan the local catalog (used by integration teardown). Generated stills are titled with a filename; match them by prompt.
- `project.assets.remove` `{ id?, ids?, projectId? }` — same path as Editor Assets Remove. Leaves Library. Parascene Creation stays; Images/Videos ungroups. Timeline use is the only blocker.
- `project.assets.delete` `{ id?, ids?, projectId? }` — same path as Editor Assets Delete. Leaves project and Library. Parascene Creation is deleted when it exists. Timeline use is the only blocker.
- `sync.start` / `sync.folders` / `sync.thumbs` / `sync.media` — Sync page. `sync.folders` accepts optional `dropTitleContains` (drops matching pending creates/updates, keeps deletes, then uploads). Integration teardown uses `agent-test-` so project delete does not leave a stuck folder queue.
- `library.clearLocal` `{ confirm: true }` — Library creations
- `window.setSize` `{ width?, height? }` — no navigation. Default **1280×900**. Does not require signed-in.
- `help.open` `{ topicId? }` — open Help in the default browser. Does not require signed-in. Omit topicId for the contents page. Articles are static HTML under `public/help/`. Topic ids: `getting-started` (or `start`, `overview`, `screens`), `projects` (or `create-project` / `open-project`), `folders`, `local-and-cloud` (or `this-computer` / `cloud` / `remote`), `sync`, `generate` (or `generate-image`), `image-models` (or `models`), `video-models` (or `video-model`), `audio` (or `speech` / `a2v` / `audio-to-video`), `settings` (or `labs`), `tools` (or `local-tools` / `ffmpeg` / `demucs` / `whisper`). Screen jumps: `library`, `director`, `editor` (Getting started headings).

Each mutating action holds ~2s on its journey page. `shell.show` holds ~0.8s. Files still run one at a time.

# Setup

Do not teleport the app into a cooked state. A test that needs a project should `project.create`. A test that needs a folder should `folder.create`. That is the journey.

Form fill, when we need it, is an action on a live panel (`args` for the fields) — not a fixture that skips opening the panel.

# Errors / security

401 without the token. 400 on unknown action or UI timeout (45s). Fail fast when signed out.

The file `agent.json` is 0600. Anyone on the machine who can read it can drive the app. That is intentional for local tests. Never bind off loopback. Never ship this server in a production build.

# Extending

Add a row in `src-tauri/src/agent.rs` `actions()`, handle it in `src/agent/AgentBridge.tsx` `runAction`, and mention it here. Prefer a domain verb over click coordinates. Mark unfinished work `planned`, do not pretend it is wired.
