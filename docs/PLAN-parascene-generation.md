# Plan — Parascene generation dependencies

The desktop app is an **AI video creator** surface. Several capabilities depend on **Parascene video generation** (API / product), not only on local shell work. Verify and drive support upstream where missing; desktop UI can stub until the platform contract exists.

Related: [PLAN-from-chatgpt.md](./PLAN-from-chatgpt.md), Hook mocks in [mockups/hook.png](./mockups/hook.png) (short-form ~9s).

## Required / desired generation support

### 1. First–last frame workflow

Generation should accept (or clearly document):

- A **first frame** (image / keyframe)
- A **last frame** (image / keyframe)
- Prompt + other params as today

**Desktop (shipped):** Editor Generate supports independent first/last sources (timeline neighbor, Assets still, or none) across Parascene, Direct to Blue, and Replicate where the model allows FLF. Provenance stamps preview URLs + durable image sources for Form review and Generate new.

Desktop use cases: guided continuity between scenes, “bridge” clips, controlled motion between two stills. Remaining platform work is mostly deeper Blue methods (v2v / r2v) — see [PLAN-parascene-blue-direct.md](./PLAN-parascene-blue-direct.md).

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
| First–last frames on generate | **Desktop shipped** for timeline Generate; platform/API depth for new Blue methods |
| Duration control (&lt; ~9s) | Parascene platform / API (+ desktop passes through) |
| Prompt relay contract | Parascene platform + desktop assistant wiring |
| Local library of results | Desktop — [PLAN-library-sync.md](./PLAN-library-sync.md) |
| Local media tools | Desktop — [PLAN-ffmpeg.md](./PLAN-ffmpeg.md) |

## Cloud vs local vs generation-without-creation

Generation results and intermediates should not automatically imply “store everything in Parascene.” Desktop aims to take load off the web app/DB ([GUIDE-architecture-principles.md](./GUIDE-architecture-principles.md)).

**Parascene** product path stays Creation-backed (credits-first). **Direct to Blue** (Lab + Generate) ships first-party gen → local import without Creation rows. Replicate direct already follows the local-import pattern (Lab + Editor). Promoting local gens into Creations remains open.

## Desktop stance until ready

- Do not fake successful generation against unsupported params
- Document exact API gaps when probed
- Hook “Publish” and generation CTAs stay disabled or mocked until contracts are real
- Capability home: extend stubs under `src/capabilities/` / SDK when endpoints exist

## Open questions (when verifying)

- Current create/generate endpoints and params (frames, duration, parent/relay IDs)
- Auth scopes required for generation from the native public client
- Desktop wait/poll cadence is [GUIDE-generate-wait.md](./GUIDE-generate-wait.md) (Rust loop; no webhook yet)
- Cost / rate limits that affect UX (queue UI, partial failures)
