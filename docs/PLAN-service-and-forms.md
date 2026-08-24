# Plan: Service API and shared forms

Extends `docs/PLAN-backend-ownership.md` (Rust owns loops; FE enqueues and paints). This plan is the shape: one service front door, one form renderer, one asset id.

Status: direction settled; migration incremental.

Related: `docs/GUIDE-architecture-principles.md`, `docs/GUIDE-desktop-vs-web.md`, `docs/GUIDE-generation-inputs-provenance.md`, `docs/PLAN-generation-provenance.md`, `docs/PLAN-backend-ownership.md`.

## Direction, agreed

Wrong: React orchestrates Parascene / Blue / Replicate recipes and ships a new form per intent×server.

Target: React collects values, calls `service_invoke`, watches a handle, paints status. Rust describes the form, provisions inputs, runs the loop, writes provenance.

Do not invent a second job queue. Keep SQLite `jobs` + `jobs-updated`. Put a kernel in front.

"Form" in the provenance guide is the Result | Form review pane. WorkflowForm is the input collector. Do not rename or replace the dual view.

`src/capabilities/index.ts` is unused stubs. Do not revive it.

Hot catalog reads (`library_list_creations_page`), `media://`, clipboard stay thin commands for now.

## Contracts

Commands: `service_list`, `service_describe`, `service_invoke`, `service_get`, `service_cancel`, `service_list_runs`.

`service_describe` returns capability, field schema, credential gate, placement, and whether timeline context is required.

`service_invoke` always returns a handle. Job id if it can take time or must survive remount. Sync result only for cheap reads (creds status, capabilities cache).

```ts
type AssetRef = { id: string }; // catalog creation id only

type CreationTarget = "assets" | "timeline";

type PlacementPolicy = {
  lane: "parascene" | "blue_direct" | "replicate" | "local";
  inputs: "creation_required" | "local_ok" | "none";
  outputs: "creation_and_catalog" | "local_catalog_only" | "files_only";
  intermediates: "transport_only" | "durable_local";
};

type ServiceInvoke = {
  service: "parascene" | "blue" | "replicate" | "local" | "catalog" | "sync" | "publisher" | "auth";
  operation: string; // generate | sync_newest | render | extract_frame | …
  payload: Record<string, unknown>;
  target?: CreationTarget;
  projectId?: string;
  clientRequestId?: string;
};
```

A creation is a creation (still, video, or audio). Kind is a field on the row. Target is assets (file into the project pool) or timeline (same creation plus a clip). Same `generate`. Not two stores.

`destinationPolicy` is a UX default or “this run needs clip/range as input.” It is not a different object type. T2V → Assets and T2I → timeline are the same adapter with a different `target`.

FE currency is `AssetRef`. Slots, drafts, Clone, and review store `{ id }`. Preview uses catalog / `media://` — one helper. No `localPath`, `remoteUrl`, or `isLocal` on form state. Timeline neighbor / none are source intents; extract-then-provision is the adapter.

Placement (from describe, not a form if):

- Parascene: model cannot read desktop paths. Durable I2V/I2I/FLF inputs become Creations. ffmpeg extracts are transport only; drop them as project members.
- Blue direct / Replicate: local files are first-class. Do not mint a Creation so generate works. Output is local catalog only.
- Local tools: stay on disk.
- Sync / publish: the only local → cloud moves. Promote-to-Creation is an explicit future operation, never a hidden fallback.
- Missing creds: typed `needs_credentials` for that lane. No Blue-direct → Parascene fallback.

Activity lives on the handle:

```text
queued → running → waiting → done
                   ↘ failed
                   ↘ cancelled
```

Named checkpoints (`provision_inputs`, `extract_frame`, `create`, `wait`, `ingest`). Form lock and `pre_gen | running | done | error` derive from handle status. Cancel is `service_cancel`. Remount reattaches by id.

Do not conflate this with asset lifecycle (temporary / candidate / selected / discarded) or project-folder lifecycle. Those are after `done`.

Provenance is `method` + `args` + lane + input `AssetRef`s. Parascene writes via Creation `meta` (ingest only — no post-gen `remoteJson` desktop stamp). Blue / Replicate stamp Parascene-shaped `meta.desktop` in the adapter. One reader: `resolveAddAssetGenerationFromCreation`. After success, Form shows the durable refs the model used. Close leftover `local-*` FIRST after a Parascene upload inside the adapter, not in the form.

Adapter trait: `describe`, `validate`, `start`, `poll_or_resume`, `cancel`, `ingest`. Generic operations (`generate`, `sync_catalog`, `render`) — not `lab_*`. One remote→catalog mapper: `map_remote_creation_json`.

FE façade: `src/services/serviceClient.ts` (copy `src/jobs/jobsClient.ts`). Shrink `blueClient`, `replicateClient`, `ParasceneSdk`.

## Forms

Lift, do not reinvent: `ReplicateInputField` (`src/replicate/replicateClient.ts`), `src/layouts/lab/labSchemaForm.ts`, `labRunFormPersist.ts`, `replicateRunConstraints.ts`, `previewIntent.ts`, `generateDualView.ts`.

One `SchemaFields` renderer. Generate overlays intent, target, Result | Form, lyrics / duration / continuity. Keep `AddAssetIntentFooter`; swap the field body. Submit is only `service_invoke`. Prefer `<form onSubmit>`.

Media slot: preview at project aspect + Choose… Value is `AssetRef` (or a source intent). One slot for project pick / library / none / timeline neighbor.

Lab = schema almost raw. Generate = curated `intent × server × model` on the same widgets. Settings creds = tiny schema on `auth.*`. No new form library.

## Phases

Note to the implementer: mark `[x] built` with the date. Do not mark `validated`. If a phase ships partially, note what is missing instead of checking the box.

- Phase 0 — Contract: [x] built (2026-08-23) · [ ] validated
  Types (`FieldSchema`, `ServiceInvoke`, `ServiceHandle`, `PlacementPolicy`, `CreationTarget`, `AssetRef`, `ActivityState`, `ProvenanceRecord`) + `serviceClient` + tests. No UI switch.
- Phase 1 — Kernel: [x] built (2026-08-23) · [ ] validated
  Rust registry on the existing jobs table. Port one already-jobbed kind (`create_media` or `ensure_project_groups`). All six existing job kinds registered as `parascene.*` operations.
- Phase 2 — Lab forms: [x] built (2026-08-23) · [ ] validated
  Extracted `SchemaFields` / `SchemaScalarField` (`src/forms/`). Lab Blue + Replicate run forms use it for scalars; file slots still panel-local. Lab submit → `service_invoke` via `blue_generate` / `replicate_generate` job kinds + `src/services/labGenerate.ts`. Batch Replicate = N queued jobs (worker is serial).
- Phase 3 — Stills + both targets: [x] built (2026-08-24) · [ ] validated
  All three T2I lanes via `service_invoke` + placeholder store; unified `useTextToImageForm` / `WorkflowForm`; Assets + Timeline targets; legacy per-server form wrappers deleted. I2I → Timeline still coming-soon (deferred).
- Phase 4 — Video / audio: [x] built (2026-08-24) · [ ] validated
  Editor + Lab create/wait/file → `service_invoke`. WorkflowForm owns Generate Model (Blue) + Prompt (all servers); Replicate model select stays custom (per-option disable reasons). Legacy FE waits: resume by pendingCreationId only.
- Phase 5 — Other operations: [x] built (2026-08-24) · [ ] validated
  `sync.sync_newest`, `sync.cloud_repair`, `local.merge`, `local.extract_frame` (Result), `publisher.render`, `auth.status`. OpenAI key via keychain_* (SQLite in debug). Deferred: full folder sync protocol, projects on disk.
- Phase 6 — Shrink: [x] built (2026-08-24) · [ ] validated
  Production paths off `createAuthedSdk`. Catalog sync, folder pull/mutate, group ops, audio/image upload, credits via service_invoke. SDK retained for types + session factory only.

Later (same widgets, not a new system): Lab prompt modules, Director title/aspect, Join Studio, slideshow, composite, folder modals, login. MV stays separate panels.

## Done when (per vertical)

- FE has no create / wait / upload / import loop
- One form renderer; differences come from `describe`
- Leave / remount / restart reattaches by handle (no double-mint when checkpoint allows)
- Submit and review have no local-vs-cloud branch
- Form shows durable `AssetRef`s (see `docs/GUIDE-generation-inputs-provenance.md`)
- Assets vs timeline are the same generate

## Not this

- UI in Rust
- A DAG engine or second job table
- Generate as open as Lab on day one
- Wrapping catalog grid reads first
- Replacing the Result | Form review pane
- Chat / ShotSpec now — they should call the same `service_invoke` later (`docs/BACKLOG-desktop.md`)
