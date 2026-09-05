# Plan: Local agent interface, integration testing, documentation

Local, dev-only semantic API on the running desktop app. Same surface later serves integration tests, in-app help verification, screenshot generation, and (later) agent QA. Not screenshots or DOM as the source of truth. LLM discovers workflows once; repeat runs are deterministic and token-cheap.

This file is the full requirements capture after the 2026-09-04 design session. Do not implement from the original draft alone.

# Hard constraint: no regressions for current users

Do not lose a current user’s library, projects, or settings. Phase 0a did relocate the existing tree into `users/<slug>/` on first logout (paths rewritten, same catalog and `parascene.projects.v1` keys). After that, each account is that folder only.

Original “keep `~/Movies/Parascene/` unscoped until a second user” is superseded. See Phase 0a.

# Settled decisions

- Help lives in this app, not parascene.com/help.
- Tests have setup and teardown. Cloud leftovers on the test account are a product bug, not acceptable junk.
- Live Parascene only (already-logged-in session). No Direct-to-Blue. No Replicate. Be gentle with the live API. Generate: Text to Image, Parascene, `sd15: lofi_V2pre`, frog-in-a-princess-dress prompt.
- Agent/tests connect to an already-running `tauri dev` app. Do not launch or control the process in this phase.
- Design the API so a future agent could use it. LLM/chat integration is out of scope. First consumer is integration tests.
- First workflows: sync, create project, create folder, generate an image in a project (Parascene product / credits path). Folders and projects are still decoupled — test where behavior differs.
- Tests assume the running app is logged in. Fail fast if not. Owner will use a cheaper test user, not the personal account.
- Prerequisite before the agent API: account isolation (done). Cloud teardown (0b) shipped with Phase 2.
- Tests and in-app help are the same journeys most of the time. A user-visible workflow gets a test and an article. The test stays on the page a person would use. Health and teardown-only steps can stay tests-only.

# Phase 0a — Account isolation (done 2026-09-05)

Logout → other user → back must not touch the first user’s library, projects, catalog, settings, or API keys.

Shipped (first logout relocates the existing tree; not the “keep unscoped until a second user” layout above):

- Machine root: `accounts.json`, live `session.sqlite` (debug auth KV + OAuth), `users/`.
- Each user: `users/<slug>/` with Library, Projects, Exports, Cache, and `user.sqlite` (localStorage, Settings secrets, identity, queues).
- Fail-closed compact on logout; hydrate + secret restore on login. Legacy root migrates with a journal and path rewrite.
- Empty ghost `Library/` at machine root is pruned once a user bundle exists.
- New sub is refused while an unclaimed legacy library is still at the root. Same in-session user may keep that root until logout.
- Debug Settings keys live in `session.sqlite`, not Keychain; compact reads that store and does not wipe `user.sqlite` secrets on an empty snapshot.

Done: personal and test accounts each keep their own folder; switch back restores that world.

# Phase 0b — Cloud lifecycle (done 2026-09-05, with Phase 2)

Do not build this before the agent API. First need a place that would call teardown.

Parascene already soft-deletes creations (`DELETE /api/create/images/:id`). Folders/projects have similar cloud deletes. The gap is product UI, not the HTTP verb.

When Phase 2 tests need cleanup, expose those as agent actions (`cloud.delete`, later folder/project). Not a full Settings/Library delete rewrite.

Local `deleteProject` only drops the device document and keeps media. That is not teardown.

Shipped: `cloud.delete` unfiles, ungroups, soft-deletes, drops local rows, and fails if any remain. `project.delete` / `folder.delete` for leftovers. `library.lookup` checks they are gone.

Done: setup/teardown can remove the test user’s generations and test folders without leaving `agent-test-*` junk, without hammering the API.

# Phase 1 — Local dev-only agent API (done 2026-09-05)

Connect only. Dev/test builds. Never in a normal production build.

```ts
interface AgentApi {
  getState(scope?: string): unknown
  getActions(scope?: string): AgentAction[]
  invoke(action: string, args?: unknown): AgentResult
  reset(): AgentResult
  getErrors(): AgentError[]
  getLogs(scope?: string): AgentLog[]
}
```

Transport is whatever is simple and local (HTTP, WebSocket, Tauri bridge). Stability of the semantic API matters more than the pipe.

Prefer domain actions (`project.create`, `folder.create`, `sync.start`, `generation.start`) over click-at-x-y. Low-level UI is a fallback, not the default.

State is scoped and compact (`getState("timeline")`), not a full dump or screenshot. Actions should return what changed when practical.

Do not add `loadFixture`. Teleporting into a cooked app state is an anti-pattern here: the test would skip the same create/open/sync path a user (and help) must take. Setup is a sequence of `invoke` actions. Form fill, if needed, is an action on a live panel — not a saved world.

Stable `data-agent-id` / aria-labels on important controls as a UI bridge when a domain action is not enough.

Write `docs/dev/agent-interface.md`: enable, connect, commands, state scopes, actions, errors, security, how features extend the API.

Shipped: debug-only loopback HTTP, `~/Movies/Parascene/agent.json`, Bearer token, `docs/dev/agent-interface.md`. UI bridge runs domain actions. Concurrent accept so a long generate does not block health.

Done: an external client can connect to the running dev app, inspect state, run semantic actions, see the result, see errors, reset. No screenshot interpretation.

# Phase 2 — First integration tests (+ 0b teardown) (done 2026-09-05)

First set is live: health, sync, project, folder, generate + teardown. Suites are `01`–`05`, one file at a time. Actions stay on the page a person would use (Library, Sync, Project → Director / Editor New asset) and hold ~2s. `cloud.delete` must leave no catalog rows.

Against the running app, through the agent API, no mocks of internals, no screenshots, no LLM on the normal run.

Harness: `integration/NN-*.integration.test.*` (01 connect, 02 sync, 03 project, 04 folder, 05 generate), one file at a time. 90s default / 20m for sync. `npm test` excludes them. `npm run test:integration` is the only runner. Sync test: fail if signed out → `library.clearLocal` (catalog + local folder shells) → `needsSync` → `sync.start` (newest) → `sync.folders` → `sync.thumbs` → `sync.media`.

Do Phase 0b here: agent actions that call Parascene soft-delete for whatever the test created.

Pattern: setup → user-relevant actions → query state → assert → teardown.

Write each first-set test as the journey a help article will later describe. Same pages, same order. Do not grow a second outline for docs.

First set (high value, already somewhat stable, first things a user must do):

- Sync: trigger sync, wait until the app reports idle/success. Prefer the narrower sync the app already has (newest / folders) over a full hammer. Do not full-resync the library on every test.
- Create project: project exists and becomes active. Also assert the bound project folder where that is how create-project works.
- Create folder: a Library folder, because folders and projects are still decoupled. Test the differences, not only the project-owned folder.
- Generate image in a project: Parascene product path, cheap prompt, long wait. Keep this off the default tight loop if it is too costly; still a first-class test, not Blue/Replicate.

Auth: fail fast if not logged in.

Done: those workflows run against the live app, through the API, from setup/teardown, with deterministic pass/fail, no screenshots, no LLM.

# Phase 3 — In-app desktop help (done 2026-09-05)

Help is part of this app. Do not stand up a second docs platform and do not land articles only on the website.

Shipped: separate Help window (not a modal). macOS Help → Parascene Desktop Help. Windows: account menu / login Help / F1 (frameless, no menu strip). `?` when not typing. `help.open` `{ topicId? }`.

Articles are static HTML under `public/help/`, linked with a back control on detail pages. First-run screenshots in `public/help/desktop/screens/` (1280×900, one-still new account):

- getting started — login, Library (one still), Sync, empty Projects, Director, Editor, New asset
- sync
- projects (create / open / close / delete)
- folders (regular vs project)
- generate an image (Parascene Text to Image)
- local tools (FFmpeg required; Demucs / Whisper optional; Settings → Local tools)
- overview of the main screens

Export later, after this slice is proven.

Behavioral truth stays the agent API. `src/help/help.test.ts` locks topic links and the button labels the journeys name. Topic ids: `getting-started`, `overview`, `projects`, `folders`, `sync`, `generate`, `tools`, plus screen jumps `library`, `director`, `editor`.

Done: several in-app articles exist, match the tested journeys and the first-run screens, and stale button-label copy can be detected. Follow-the-API help audit and screenshot regen stay Phase 4.

# Phase 4 — Expand coverage

Only after 0–3 are cheap and maintainable.

More tests: projects, assets, timeline, editing, generation, references, audio, models, settings, save/load, export, failures, recovery.

More help around user goals, not code folders.

Lightweight feature → tests → help mapping (yaml or similar), enough to answer “this feature changed; what tests and docs might be stale?”

Optional screenshot regen from known states. Not the source of truth.

Later: a release audit that runs affected tests, checks help journeys, flags stale screenshots.

# Phase 5 — Part of feature definition of done

For user-visible changes, the coding agent: find affected workflows, run those integration tests, add/update tests if behavior changed, verify affected help, update copy, regen screenshots only if the documented UI materially changed.

Do not touch tests or docs only because implementation files changed. Observable behavior only.

LLM is for understanding new work, discovering a workflow, diagnosing a failed deterministic test, deciding if help is affected, rewriting help, and odd failures. Normal test runs spend no LLM tokens.

Prefer structured state, scoped queries, diffs, semantic actions, deterministic tests, changed-feature metadata.

Avoid full-repo dumps, full DOM, repeated screenshots, vision navigation, re-running known workflows through an LLM, reviewing the whole help corpus.

# Intended end state

implement feature → run affected integration tests → exercise the changed workflow through the agent API → update deterministic tests → verify affected help → update help/screenshots if needed → done.

The running application is the source of behavioral truth. Tests verify it. Help describes it. The local agent API is the shared machine-readable surface.

That keeps docs from drifting for a solo developer, and leaves a door for later QA, release audits, screenshot generation, and a user-facing assistant without building those now.