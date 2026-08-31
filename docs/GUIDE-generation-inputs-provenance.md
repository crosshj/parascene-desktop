# Guide — Generation inputs & provenance (by server)

**Status:** Settled principles — implementation debt remains (see “Current flaw”)  
**Audience:** Anyone changing Generate, frame extract/upload, Form review, catalog stamps, or sync  
**Related:** [GUIDE-generate-source-images.md](./GUIDE-generate-source-images.md) (how to send a project still — hosted / grouped / target / video extract), [GUIDE-generate-wait.md](./GUIDE-generate-wait.md) (Parascene create wait), [PLAN-generation-provenance.md](./PLAN-generation-provenance.md), [GUIDE-architecture-principles.md](./GUIDE-architecture-principles.md), [GUIDE-desktop-vs-web.md](./GUIDE-desktop-vs-web.md), [PLAN-parascene-generation.md](./PLAN-parascene-generation.md)

---

## Why this exists

Parascene (credits / Creations) **cannot read local files**. Direct to Blue and Replicate **can**. Mixing those realities produces Forms that lie (e.g. FIRST frame labeled `local-…` after a Parascene I2V that already uploaded a Creation still).

This guide is the guardrail. Do not “fix” one server path by copying habits from another.

---

## Two worlds (never conflate)

| | **Parascene** (`parascene_blue` — credits / Creations) | **Local-capable** (`blue_direct`, `replicate`) |
|---|---|---|
| Who runs the model | Parascene cloud | Blue API or Replicate (from this machine) |
| Can the server read a desktop path / `local-*` id? | **No** | **Yes** (file upload / local bytes at call time) |
| Durable input image for I2V / I2I / FLF | A **Parascene Creation** (image) with a public/API URL | A **local catalog row** (or path) is fine |
| What Form / provenance must show as FIRST/LAST | That **Parascene still Creation id** (and/or URL in `meta.args`) | The **local** asset id / path used as input |
| Ephemeral ffmpeg extract from a timeline neighbor | Upload jpeg to Parascene ephemeral Blue CDN (`still_url`); **no** still Creation / Images member | Keep the local extract (or derived still) as the durable input |
| Catalog output provenance | Parascene Creation `meta.method` / `meta.args` (sync snapshot). **No** post-gen `meta.desktop` stamp | Local-only output → stamp **Parascene-shaped** provenance under `meta.desktop` (see below) |

```
Parascene I2V (correct):
  timeline/video → extract still (temp)
       → ephemeral Blue CDN jpeg (`still_url`)
       → generate video Creation (args.input_images = still_url)
       → Form FIRST = still_url (not a local-* id, not an Images member)
       → drop temp local extract from project membership

Local-capable I2V (correct):
  timeline/video → extract still (local catalog row)
       → pass local file to Blue/Replicate
       → import result locally
       → Form FIRST = local still id
       → stamp meta.desktop with Parascene-like args (method, prompt, model, input refs)
```

---

## Non-negotiables

### 1. Server path decides input durability

Before writing extract / upload / stamp / Form code, ask: **which Generate server is this?**

- If `parascene_blue` → every image the model sees must be a URL Parascene can fetch: an existing **Creation** URL, or an **ephemeral still_url** (timeline extract). Local paths are transport only.
- If `blue_direct` / `replicate` → local files are first-class inputs. Do not invent a Parascene Creation just to hold a frame unless the user explicitly publishes.

### 2. Provenance tells the truth about what the model saw

After a successful gen, Form / `addAssetGeneration` / derived meta must name the **inputs the model actually used**, not the temporary disk scratch used to produce them.

**Anti-pattern (current flaw):** Parascene I2V uploads a framed still as Creation `25802`, but Form FIRST still shows `local-1787464859577-5012-0`. That local id was never what Parascene consumed.

### 3. Parascene project gen ≡ synced cloud asset

Same as [PLAN-generation-provenance.md](./PLAN-generation-provenance.md): after Parascene generate, **do not** rewrite catalog `remoteJson` for provenance. Sync’s snapshot of Creation meta is enough. Project-made and sync-only rows must match.

### 4. Local-only gens still use a Parascene-like data shape

Direct to Blue / Replicate outputs are not Creations, but provenance must not be a one-off Editor-only struct forever.

Store (under `meta.desktop` and/or a shared schema) something **isomorphic** to Parascene’s generation record:

- `method` / intent (e.g. image→video)
- `args`: prompt, model, aspect ratio, duration, **input image refs** (local creation ids and/or file identity)
- timestamps, server lane (`blue_direct` | `replicate`)

Readers (`resolveAddAssetGenerationFromCreation`, Form, future “how was this made?”) should prefer one mental model: **args + method + inputs**, whether those inputs are Creation URLs or local ids.

### 5. Do not file throwaway extracts into the project for Parascene

Uploading an extract for Parascene may temporarily create a catalog row. After it is a Creation and filed (if needed as a still asset), **do not** leave the pre-upload `local-*` extract as a project member “because we extracted it.” The Creation still is the project-facing input. Temp locals are cache/transport.

(Local-capable servers: the extract **is** the durable input — keeping it in the project/catalog is correct.)

### 6. Timeline clip stamps vs catalog

- **Timeline `addAssetGeneration`:** may hold rich editor continuity (frame sources, preview URLs) for the session/project doc.
- **Catalog `remoteJson`:** Parascene → API meta only; local-only → desktop Parascene-like stamp.
- When promoting timeline review → Assets Form, **rewrite frame sources to the durable ids** for that server (Creation id vs local id), never leave a dead `local-*` that was only a bridge.

### 7. Form start stills — one helper for every intent

Locked Form review (I2I, I2V, and any gen that used start stills) resolves FIRST/LAST through `resolveGenerationFramePreviews` / `loadGenerationFramePreviews` in `src/project/generationFramePreviews.ts`. Output modality must not own a separate preview path.

- Prefer stamped `startFramePreviewUrl` / `endFramePreviewUrl`, then asset ids, then catalog `getCreations` + `creationPreviewUrl`.
- **Locked review must never skip preview load** solely because fields are locked — that produced empty “Selected image is not available yet” when the still id was already known.
- When a timeline/catalog stamp’s `intentId` disagrees with Parascene `meta.method`, prefer derive for the Form lane (`mergeStampWithDerivedGeneration`) while keeping durable frame ids/URLs.


---

## Parascene frame identity (shipped)

Parascene Image→Video must not leave a dual identity for the start still:

1. Temp ffmpeg extract is upload transport only — **not** imported as `local-*` into the project.
2. Video extracts go to ephemeral Blue CDN (`still_url`). Do not file Images. Hosted fit stills stay Creation URLs. Fill/stretch of a project image still uploads a new Creation (append the new id only). Never regroup the source. See [GUIDE-generate-source-images.md](./GUIDE-generate-source-images.md).
3. Success stamps FIRST/LAST to the durable input (Creation id or `still_url`).
4. Read heal: `local-*` FIRST stamps clear when Parascene `meta.args.input_images` already names the still URL.

Local-capable servers (`blue_direct` / `replicate`) still import local stills as durable flat project members — do not copy Parascene habits onto those lanes.

---

## Checklist before merging Generate / frame changes

- [ ] How is the source still sent? See [GUIDE-generate-source-images.md](./GUIDE-generate-source-images.md) (hosted / grouped / target / video extract). Never regroup an existing Images member.
- [ ] What is the **durable** input the model sees? (Creation vs local)
- [ ] Does Form / provenance show that durable input after success?
- [ ] Are temp extracts excluded from project membership on the Parascene path?
- [ ] For local-only: is Parascene-like `method`/`args` stamped on the output row?
- [ ] For Parascene: was catalog `remoteJson` left as the API snapshot (no pointless desktop stamp)?

---

## Code map (entry points)

| Concern | Where to look |
|---------|----------------|
| Upload extract → Parascene still | `src/layouts/editor/addAssetGenerate.ts` (`prepareParasceneGenerationStill`, `uploadFramedStill`) |
| Success / frame source stamping | `src/layouts/editor/addAssetGenerationStore.ts`, `ShellProvider` |
| Form FIRST/LAST display | `generationFramePreviews.ts` → `AddAssetGeneratePanel` / I2I Form (`useParasceneImageToImageForm`) |
| Catalog provenance resolve | `src/project/desktopAddAssetGeneration.ts` |
| Server ids | `src/layouts/editor/previewIntent.ts` (`GenerateServerId`) |

When in doubt, re-read this guide before adding another special case.
