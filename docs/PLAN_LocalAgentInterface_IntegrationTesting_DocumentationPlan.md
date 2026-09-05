# Plan: Local agent interface, integration testing, documentation

Local, dev-only semantic API on the running desktop app. Same surface later serves integration tests, in-app help verification, screenshot generation, and (later) agent QA. Not screenshots or DOM as the source of truth. LLM discovers workflows once; repeat runs are deterministic and token-cheap.

This file is the full requirements capture after the 2026-09-04 design session. Do not implement from the original draft alone.

# Hard constraint: no regressions for current users

People already using the app with a synced library at `~/Movies/Parascene/` must see zero behavior or data-path change.

- Same folder, catalog, projects, sync, session restore.
- No move, copy, rename, or second Library for that tree.
- `parascene.projects.v1` and `parascene.shellSession.v1` stay the keys for that user. Do not re-key in a way that empties the project list.
- An app update must not point the running app at an empty scoped folder.
- Logout only clears the session. Files stay. Signing back in as the same user picks up as if nothing happened.
- Single-account machines (existing or new) keep today’s unscoped layout. New code paths run only when a second distinct user signs in on that machine.
- Do not auto-migrate the first user into `users/<id>/`. “Eventually all scoped” is later, explicit, idle, reversible — not an update side effect.

If a change could affect a current single-user install, do not make it.

# Settled decisions

- Help lives in this app, not parascene.com/help.
- Tests have setup and teardown. Cloud leftovers on the test account are a product bug, not acceptable junk.
- Live Parascene only (already-logged-in session). No Direct-to-Blue. No Replicate. Be gentle with the live API. Generate uses a cheap prompt (owner will name the cheap path).
- Agent/tests connect to an already-running `tauri dev` app. Do not launch or control the process in this phase.
- Design the API so a future agent could use it. LLM/chat integration is out of scope. First consumer is integration tests.
- First workflows: sync, create project, create folder, generate an image in a project (Parascene product / credits path). Folders and projects are still decoupled — test where behavior differs.
- Tests assume the running app is logged in. Fail fast if not. Owner will use a cheaper test user, not the personal account.
- Prerequisite before the agent API: account isolation, then cloud create/delete good enough for setup/teardown.

# Phase 0a — Account isolation (do this first)

Logout → login as another user must not read or write the previous user’s library, projects, or catalog. Switch back and the original local world is intact.

Today logout only clears the session. Disk and UI state are global:

- `~/Movies/Parascene/` — Library, `catalog.sqlite`, media, Projects, Exports, Cache
- `localStorage` — `parascene.projects.v1`, `parascene.shellSession.v1`
- Debug builds store the session inside `catalog.sqlite`

The real failure mode is not “logout wipes files.” It is: sign in as the test user, then sync and folder/project mutations run against the original user’s catalog.

Layout:

- One account: keep `~/Movies/Parascene/` exactly as today.
- Second account: new user only gets `~/Movies/Parascene/users/<userId>/`. Original tree stays put.
- Fresh single-user install: still unscoped (same as today) until a second user appears.
- `accounts.json` (or equivalent) is written only when a second account is actually added. Until then, path resolution is the current code path.

Sign-out keeps the previous user’s files. Re-login as that user restores that tree. Re-OAuth is fine; data must not need to be rebuilt.

Done when: owner can log out of the personal account, log in as the test user, work, log out, log back in as the personal account, and the original library/projects/sync state are unchanged.

# Phase 0b — Cloud lifecycle (in parallel / next)

The client is weak at managing Parascene cloud artifacts. Tests cannot teardown if the app cannot create and delete what it creates.

Extend existing Parascene delete/unbind paths (`deleteCreation`, `deleteFolder`, project-folder unbind) until a test can create a project, a folder, and a generated image, then remove those cloud objects.

Local `deleteProject` today removes the project on this device, keeps library media, and turns the project folder into a regular Library folder. That is not teardown.

Done when: setup/teardown can manage the test user’s cloud folders, project bindings, and generations without leaving permanent junk, without hammering the API.

# Phase 1 — Local dev-only agent API

Connect only. Dev/test builds. Never in a normal production build.

```ts
interface AgentApi {
  getState(scope?: string): unknown
  getActions(scope?: string): AgentAction[]
  invoke(action: string, args?: unknown): AgentResult
  loadFixture(name: string): AgentResult
  reset(): AgentResult
  getErrors(): AgentError[]
  getLogs(scope?: string): AgentLog[]
}
```

Transport is whatever is simple and local (HTTP, WebSocket, Tauri bridge). Stability of the semantic API matters more than the pipe.

Prefer domain actions (`project.create`, `folder.create`, `sync.start`, `generation.start`) over click-at-x-y. Low-level UI is a fallback, not the default.

State is scoped and compact (`getState("timeline")`), not a full dump or screenshot. Actions should return what changed when practical.

Fixtures exist for known states (`empty-project`, and later populated ones). First tests still favor live setup/teardown over pretending the cloud does not exist.

Stable `data-agent-id` / aria-labels on important controls as a UI bridge when a domain action is not enough.

Write `docs/dev/agent-interface.md`: enable, connect, commands, state scopes, actions, fixtures, errors, security, how features extend the API.

Done when an external client can: connect to the running dev app, load or set up a known state, inspect state, run several semantic actions, see the result, see errors, reset. No screenshot interpretation.

# Phase 2 — First integration tests

Against the running app, through the agent API, no mocks of internals, no screenshots, no LLM on the normal run.

Pattern: setup → user-relevant actions → query state → assert → teardown.

First set (high value, already somewhat stable, first things a user must do):

- Sync: trigger sync, wait until the app reports idle/success. Prefer the narrower sync the app already has (newest / folders) over a full hammer. Do not full-resync the library on every test.
- Create project: project exists and becomes active. Also assert the bound project folder where that is how create-project works.
- Create folder: a Library folder, because folders and projects are still decoupled. Test the differences, not only the project-owned folder.
- Generate image in a project: Parascene product path, cheap prompt, long wait. Keep this off the default tight loop if it is too costly; still a first-class test, not Blue/Replicate.

Auth: fail fast if not logged in.

Done when several of those workflows run against the live app, through the API, from setup/teardown, with deterministic pass/fail, no screenshots, no LLM.

# Phase 3 — In-app desktop help

Help is part of this app. Do not stand up a second docs platform and do not land articles only on the website.

Articles correspond to the tested journeys, written for a person (not a serialized test):

- getting started
- creating/opening a project
- importing / library folders vs project folders where they differ
- generating an image (Parascene)
- exporting later, after the first slice is proven

Screenshots are replaceable generated assets (`help/desktop/timeline/split-clip.webp`), not hand-maintained forever. Behavioral truth stays the agent API.

A coding agent should be able to read an article, follow it against the running app, and report mismatches.

Done when several in-app articles exist, match tested journeys, can be followed through the API, and stale copy can be detected.

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

Prefer structured state, scoped queries, diffs, semantic actions, fixtures, deterministic tests, changed-feature metadata.

Avoid full-repo dumps, full DOM, repeated screenshots, vision navigation, re-running known workflows through an LLM, reviewing the whole help corpus.

# Intended end state

implement feature → run affected integration tests → exercise the changed workflow through the agent API → update deterministic tests → verify affected help → update help/screenshots if needed → done.

The running application is the source of behavioral truth. Tests verify it. Help describes it. The local agent API is the shared machine-readable surface.

That keeps docs from drifting for a solo developer, and leaves a door for later QA, release audits, screenshot generation, and a user-facing assistant without building those now.
