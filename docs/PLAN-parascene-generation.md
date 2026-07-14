# Plan — Parascene generation dependencies

The desktop app is an **AI video creator** surface. Several capabilities depend on **Parascene video generation** (API / product), not only on local shell work. Verify and drive support upstream where missing; desktop UI can stub until the platform contract exists.

Related: [PLAN-from-chatgpt.md](./PLAN-from-chatgpt.md), Hook mocks in [mockups/hook.png](./mockups/hook.png) (short-form ~9s).

## Required / desired generation support

### 1. First–last frame workflow

Generation should accept (or clearly document):

- A **first frame** (image / keyframe)
- A **last frame** (image / keyframe)
- Prompt + other params as today

Desktop use cases: guided continuity between scenes, Director/Editor “bridge” clips, controlled motion between two stills. Confirm current Parascene API support; if absent, track as **platform work** before depending on it in the app.

### 2. Explicit duration (prefer under 9 seconds)

Need the ability to **specify clip duration**, ideally targeting **under ~9 seconds** (Hook / short-form, mock “9.0 seconds” badge).

- Confirm whether duration is API-selectable today, what mins/maxes/steps are allowed
- Prefer short clips as a first-class target for Hook and teaser flows
- Desktop should pass duration through; do not invent length if the API rejects it

### 3. Prompt relay workflow

Want a **prompt relay** path: chain or hand off prompts across steps (e.g. Director natural-language intent → refined generation prompt → follow-up generation / variation), rather than a single one-shot box with no memory of prior creative context.

Clarify with Parascene product/API what “relay” means in practice (session of jobs, parent creation IDs, assistant-shaped rewrite, etc.), then expose a thin desktop client for it. Until then, keep LLM assistant stubs local-only.

## Ownership

| Concern | Likely owner |
| --- | --- |
| First–last frames on generate | Parascene platform / API (+ desktop client once stable) |
| Duration control (&lt; ~9s) | Parascene platform / API |
| Prompt relay contract | Parascene platform + desktop assistant wiring |
| Local library of results | Desktop — [PLAN-library-sync.md](./PLAN-library-sync.md) |
| Local media tools | Desktop — [PLAN-ffmpeg.md](./PLAN-ffmpeg.md) |

## Cloud vs local vs generation-without-creation

Generation results and intermediates should not automatically imply “store everything in Parascene.” Desktop aims to take load off the web app/DB ([PLAN-architecture-principles.md](./PLAN-architecture-principles.md)).

**Open (“provider” clarified):** whether some jobs may hit **Parascene’s generation server** and return media **without** inserting a **Creation** (or equivalent) in the Parascene database — for local-only / ephemeral desktop work. This is not desktop→third-party model APIs by itself. Undecided — do not build until product + API choose a path.

## Desktop stance until ready

- Do not fake successful generation against unsupported params
- Document exact API gaps when probed
- Hook “Publish” and generation CTAs stay disabled or mocked until contracts are real
- Capability home: extend stubs under `src/capabilities/` / SDK when endpoints exist

## Open questions (when verifying)

- Current create/generate endpoints and params (frames, duration, parent/relay IDs)
- Auth scopes required for generation from the native public client
- Async job status / webhook vs poll for desktop
- Cost / rate limits that affect UX (queue UI, partial failures)
