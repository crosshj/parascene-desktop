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

# Actions

Wired (need a signed-in session; UI must be up):

- `project.create` `{ title? }` — opens the project; returns bound project folder
- `project.open` `{ id }`
- `project.close`
- `project.delete` `{ id }` — local project; leftover folder deleted when empty
- `folder.create` `{ title? }` — Library folder, not a project folder
- `folder.delete` `{ id }` — empty regular Library folder
- `generation.start` `{ prompt?, projectId?, model? }` — Parascene Text to Image, default `sd15: lofi_V2pre` (~0.1 credit). Returns `creationId` and `imagesGroupId` (delete both).
- `cloud.delete` `{ id?, imagesGroupId?, ids? }` — unfile, ungroup, soft-delete, drop local rows; fails if any remain
- `library.lookup` `{ id?, ids? }` — which of those creation ids still exist locally

- `sync.start` — Sync Newest only
- `sync.folders` — pull cloud folder membership (same step as the Sync page after catalog)
- `sync.thumbs` — cache missing local previews; waits until idle
- `sync.media` — cache missing full local media; waits until idle
- `library.clearLocal` `{ confirm: true }` — drop cloud-backed local catalog + files (not cloud; keeps disk imports)

Each action stays on the page a person would use and holds ~2s: Library for folders/delete, Sync for the sync journey, Project → Director for create/open, Project → Editor (New asset) for generate. Files still run one at a time. Those pages are the same ones help will describe.

# Setup

Do not teleport the app into a cooked state. A test that needs a project should `project.create`. A test that needs a folder should `folder.create`. That is the journey.

Form fill, when we need it, is an action on a live panel (`args` for the fields) — not a fixture that skips opening the panel.

# Errors / security

401 without the token. 400 on unknown action or UI timeout (45s). Fail fast when signed out.

The file `agent.json` is 0600. Anyone on the machine who can read it can drive the app. That is intentional for local tests. Never bind off loopback. Never ship this server in a production build.

# Extending

Add a row in `src-tauri/src/agent.rs` `actions()`, handle it in `src/agent/AgentBridge.tsx` `runAction`, and mention it here. Prefer a domain verb over click coordinates. Mark unfinished work `planned`, do not pretend it is wired.
