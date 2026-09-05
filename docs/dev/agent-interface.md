# Dev agent interface

Local HTTP API on the running `tauri dev` app. Debug builds only. Not compiled into release.

# Integration tests

`npm test` never runs these. From the repo root, with `npm run dev` already up:

```bash
npm run test:integration
```

Files live in `integration/*.integration.test.*`, numbered so they run in order: `01` connect, `02` sync, `03` project, `04` folder, `05` generate. They talk to the live loopback API only. One file at a time.

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
- `generation.start` `{ prompt?, projectId?, model? }` — lands Editor, then generates. Default `sd15: lofi_V2pre` (~0.1 credit). Do not use this just to open Editor.
- `cloud.delete` `{ id?, imagesGroupId?, ids? }` — Library creations
- `library.lookup` `{ id?, ids? }` — no navigation (query only)
- `sync.start` / `sync.folders` / `sync.thumbs` / `sync.media` — Sync page
- `library.clearLocal` `{ confirm: true }` — Library creations
- `window.setSize` `{ width?, height? }` — no navigation. Default **1280×900**. Does not require signed-in.
- `help.open` `{ topicId? }` — open the Help window. Does not require signed-in. Omit topicId for the contents page. Articles are static HTML under `public/help/`. Topic ids: `getting-started` (or `start`), `overview` (or `screens`), `projects` (or `create-project` / `open-project`), `folders`, `sync`, `generate` (or `generate-image`), `tools` (or `local-tools` / `ffmpeg` / `demucs` / `whisper`). Screen jumps: `library`, `director`, `editor`.

Each mutating action holds ~2s on its journey page. `shell.show` holds ~0.8s. Files still run one at a time.

# Setup

Do not teleport the app into a cooked state. A test that needs a project should `project.create`. A test that needs a folder should `folder.create`. That is the journey.

Form fill, when we need it, is an action on a live panel (`args` for the fields) — not a fixture that skips opening the panel.

# Errors / security

401 without the token. 400 on unknown action or UI timeout (45s). Fail fast when signed out.

The file `agent.json` is 0600. Anyone on the machine who can read it can drive the app. That is intentional for local tests. Never bind off loopback. Never ship this server in a production build.

# Extending

Add a row in `src-tauri/src/agent.rs` `actions()`, handle it in `src/agent/AgentBridge.tsx` `runAction`, and mention it here. Prefer a domain verb over click coordinates. Mark unfinished work `planned`, do not pretend it is wired.
