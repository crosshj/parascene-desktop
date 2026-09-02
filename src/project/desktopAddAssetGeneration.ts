/**
 * Generation provenance for catalog Creations.
 *
 * **Parascene Creation-backed gens (server `parascene_blue`):**
 * Parascene already stores how the asset was made (`meta.method`, `meta.args`,
 * …). Sync snapshots that into `remoteJson`. UI reads it via
 * {@link deriveAddAssetGenerationFromParasceneMeta}. Do **not** rewrite
 * `remoteJson` after generate — a project-made Parascene asset must look the
 * same as one that only arrived through sync.
 *
 * **Local-only gens (Direct to Blue, Replicate direct, disk import extras):**
 * There is no Parascene Creation meta. Stamp
 * `meta.desktop.addAssetGeneration` with {@link creationUpsertWithAddAssetGeneration}
 * so Result | Form still works. Sync preserves that stamp when the cloud
 * snapshot lacks one ({@link preserveDesktopAddAssetGeneration}).
 *
 * **Timeline clips** may still carry `addAssetGeneration` in the project doc
 * for rich frame continuity while editing — that is project state, not a
 * catalog mutation.
 */

import type { Creation, CreationUpsert } from "../library/types";
import { DESKTOP_GROUP_META_KEY } from "./desktopProjectGroups";
import type { AddAssetGeneration, AddAssetGenerationMode } from "./types";
import {
  resolveFirstFrameSource,
  resolveLastFrameSource,
} from "./addAssetFrameSource";

export const ADD_ASSET_GENERATION_META_KEY = "addAssetGeneration";

/** Local copy — avoid importing editor modules from project/ (init cycles). */
function parseReplicateVideoTweaks(
  value: unknown,
): NonNullable<AddAssetGeneration["replicateTweaks"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const out: NonNullable<AddAssetGeneration["replicateTweaks"]> = {};
  if (typeof row.resolution === "string" && row.resolution.trim()) {
    out.resolution = row.resolution.trim();
  }
  if (typeof row.mode === "string" && row.mode.trim()) {
    out.mode = row.mode.trim();
  }
  if (typeof row.generateAudio === "boolean") {
    out.generateAudio = row.generateAudio;
  }
  if (typeof row.negativePrompt === "string") {
    out.negativePrompt = row.negativePrompt;
  }
  if (typeof row.seed === "number" && Number.isFinite(row.seed)) {
    out.seed = Math.floor(row.seed);
  } else if (row.seed === null) {
    out.seed = null;
  }
  if (
    typeof row.characterOrientation === "string" &&
    row.characterOrientation.trim()
  ) {
    out.characterOrientation = row.characterOrientation.trim();
  }
  if (typeof row.keepOriginalSound === "boolean") {
    out.keepOriginalSound = row.keepOriginalSound;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function trimAssetId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = [
    ...new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  ];
  return ids;
}

/** Typed Generate refs persisted on drafts and locked Form provenance. */
export function pickGenerateMediaRefFields(row: Record<string, unknown>): {
  inputVideoAssetId?: string | null;
  characterImageAssetId?: string | null;
  referenceImageAssetIds?: string[];
  referenceVideoAssetIds?: string[];
  referenceAudioAssetIds?: string[];
  timelineAudio?: "none" | "full_mix" | "vocals";
  startOffsetSeconds?: number;
} {
  const offset = Number(row.startOffsetSeconds);
  const images = stringIdList(row.referenceImageAssetIds);
  const videos = stringIdList(row.referenceVideoAssetIds);
  const audios = stringIdList(row.referenceAudioAssetIds);
  const timelineAudio =
    row.timelineAudio === "full_mix" ||
    row.timelineAudio === "vocals" ||
    row.timelineAudio === "none"
      ? row.timelineAudio
      : undefined;
  return {
    inputVideoAssetId: trimAssetId(row.inputVideoAssetId) ?? (
      "inputVideoAssetId" in row ? null : undefined
    ),
    characterImageAssetId: trimAssetId(row.characterImageAssetId) ?? (
      "characterImageAssetId" in row ? null : undefined
    ),
    referenceImageAssetIds: images,
    referenceVideoAssetIds: videos,
    referenceAudioAssetIds: audios,
    timelineAudio,
    startOffsetSeconds:
      Number.isFinite(offset) && offset > 0 ? offset : undefined,
  };
}

export function generateMediaRefFieldsAreEmpty(
  fields: ReturnType<typeof pickGenerateMediaRefFields>,
): boolean {
  return (
    !fields.inputVideoAssetId &&
    !fields.characterImageAssetId &&
    (fields.referenceImageAssetIds?.length ?? 0) === 0 &&
    (fields.referenceVideoAssetIds?.length ?? 0) === 0 &&
    (fields.referenceAudioAssetIds?.length ?? 0) === 0 &&
    (fields.timelineAudio == null || fields.timelineAudio === "none") &&
    !fields.startOffsetSeconds
  );
}

/** Normalize unknown JSON into AddAssetGeneration (shared by project + catalog). */
export function normalizeAddAssetGeneration(
  value: unknown,
): AddAssetGeneration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.prompt !== "string") return undefined;
  if (typeof row.generatedAt !== "string" || !row.generatedAt.trim()) {
    return undefined;
  }
  if (typeof row.creationId !== "string" || !row.creationId.trim()) {
    return undefined;
  }
  const mode: AddAssetGeneration["mode"] =
    row.mode === "first_last"
      ? "first_last"
      : row.mode === "motion_match"
        ? "motion_match"
        : row.mode === "none"
          ? "none"
          : "start_frame";
  const audioMode =
    row.audioMode === "full_mix"
      ? "full_mix"
      : row.audioMode === "vocals"
        ? "vocals"
        : row.audioMode === "none"
          ? "none"
          : mode === "first_last" || mode === "motion_match" || mode === "none"
            ? undefined
            : "vocals";
  const lyricsText =
    typeof row.lyricsText === "string" && row.lyricsText.trim()
      ? row.lyricsText.trim()
      : undefined;
  const model =
    typeof row.model === "string" && row.model.trim()
      ? row.model.trim()
      : undefined;
  const provider =
    typeof row.provider === "string" && row.provider.trim()
      ? row.provider.trim()
      : undefined;
  const methodId =
    typeof row.methodId === "string" && row.methodId.trim()
      ? row.methodId.trim()
      : undefined;
  const intentId =
    typeof row.intentId === "string" && row.intentId.trim()
      ? row.intentId.trim()
      : undefined;
  const server =
    typeof row.server === "string" && row.server.trim()
      ? row.server.trim()
      : undefined;
  const startFrameAssetId =
    typeof row.startFrameAssetId === "string" && row.startFrameAssetId.trim()
      ? row.startFrameAssetId.trim()
      : undefined;
  const startFrameFraming =
    row.startFrameFraming === "fill" || row.startFrameFraming === "stretch"
      ? row.startFrameFraming
      : row.startFrameFraming === "fit"
        ? "fit"
        : undefined;
  const startFramePreviewUrl =
    typeof row.startFramePreviewUrl === "string" &&
    row.startFramePreviewUrl.trim()
      ? row.startFramePreviewUrl.trim()
      : undefined;
  const endFramePreviewUrl =
    typeof row.endFramePreviewUrl === "string" && row.endFramePreviewUrl.trim()
      ? row.endFramePreviewUrl.trim()
      : undefined;
  const firstFrameSource = resolveFirstFrameSource({
    firstFrameSource: row.firstFrameSource,
    startFrameAssetId,
  });
  const lastFrameSource = resolveLastFrameSource({
    lastFrameSource: row.lastFrameSource,
    continuityMode: mode,
  });
  const legacyStartFrameAssetId =
    startFrameAssetId ??
    (firstFrameSource?.kind === "asset" ? firstFrameSource.assetId : undefined);
  const useNearestDuration = row.useNearestDuration === true ? true : undefined;
  const replicateTweaks = parseReplicateVideoTweaks(row.replicateTweaks);
  const mediaRefs = pickGenerateMediaRefFields(row);
  return {
    prompt: row.prompt,
    audioMode,
    lyricsText,
    generatedAt: row.generatedAt.trim(),
    creationId: row.creationId.trim(),
    mode,
    model,
    intentId,
    server,
    provider,
    methodId,
    startFrameAssetId: legacyStartFrameAssetId,
    startFrameFraming,
    firstFrameSource,
    lastFrameSource,
    startFramePreviewUrl,
    endFramePreviewUrl,
    inputVideoAssetId: mediaRefs.inputVideoAssetId,
    characterImageAssetId: mediaRefs.characterImageAssetId,
    referenceImageAssetIds: mediaRefs.referenceImageAssetIds,
    referenceVideoAssetIds: mediaRefs.referenceVideoAssetIds,
    referenceAudioAssetIds: mediaRefs.referenceAudioAssetIds,
    timelineAudio: mediaRefs.timelineAudio,
    startOffsetSeconds: mediaRefs.startOffsetSeconds,
    useNearestDuration,
    replicateTweaks,
  };
}

function desktopBlobFromParsed(
  parsed: Record<string, unknown>,
): Record<string, unknown> | null {
  const meta =
    parsed.meta && typeof parsed.meta === "object"
      ? (parsed.meta as Record<string, unknown>)
      : null;
  const fromMeta = meta?.[DESKTOP_GROUP_META_KEY];
  if (fromMeta && typeof fromMeta === "object") {
    return fromMeta as Record<string, unknown>;
  }
  const top = parsed[DESKTOP_GROUP_META_KEY];
  if (top && typeof top === "object") {
    return top as Record<string, unknown>;
  }
  return null;
}

/** Read generation provenance stamped on a catalog Creation (desktop stamp only). */
export function addAssetGenerationFromCreation(
  creation: Pick<Creation, "remoteJson"> | null | undefined,
): AddAssetGeneration | null {
  if (!creation?.remoteJson) return null;
  try {
    const parsed = JSON.parse(creation.remoteJson) as Record<string, unknown>;
    const desktop = desktopBlobFromParsed(parsed);
    if (!desktop) return null;
    return (
      normalizeAddAssetGeneration(desktop[ADD_ASSET_GENERATION_META_KEY]) ??
      null
    );
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstInputImageUrl(args: Record<string, unknown>): string | undefined {
  const images = args.input_images;
  if (Array.isArray(images)) {
    for (const entry of images) {
      const url = asTrimmedString(entry);
      if (url) return url;
    }
  }
  const single = asTrimmedString(args.input_image);
  return single || undefined;
}

/** Parascene create methods that are uploads / non-generates — no Result | Form. */
const NON_GENERATION_METHODS = new Set([
  "uploadimage",
  "upload",
  "import",
]);

type DerivedIntent = {
  intentId: string;
  methodId: string;
  mode: NonNullable<AddAssetGeneration["mode"]>;
};

/**
 * Map a Parascene `meta.method` (+ args / media type) into a desktop intent.
 * Returns null for uploads and unrecognized non-generative rows.
 */
function deriveIntentFromParasceneMethod(opts: {
  method: string;
  hasInputImage: boolean;
  mediaType: string;
}): DerivedIntent | null {
  const method = opts.method.trim().toLowerCase();
  if (!method || NON_GENERATION_METHODS.has(method)) return null;

  if (
    method === "text2image" ||
    method === "text2img" ||
    method === "fluximage" ||
    method === "fluximageklein" ||
    method === "pixellabimage" ||
    method === "advanced_generate"
  ) {
    return {
      intentId: "text_to_image",
      methodId: "text_to_image",
      mode: "none",
    };
  }
  if (
    method === "image2image" ||
    method === "fluximageedit" ||
    method === "img2img"
  ) {
    return {
      intentId: "image_to_image",
      methodId: "image_to_image",
      mode: "start_frame",
    };
  }
  if (method === "image2video" || method === "img2video") {
    return {
      intentId: "image_to_video",
      methodId: "image_to_video",
      mode: "start_frame",
    };
  }
  if (method === "text2video" || method === "txt2video") {
    return {
      intentId: "text_to_video",
      methodId: "text_to_video",
      mode: "none",
    };
  }
  if (method === "audio2video") {
    return {
      intentId: "image_audio_to_video",
      methodId: "image_audio_to_video",
      mode: "start_frame",
    };
  }
  if (method === "reference2video" || method === "ref2video") {
    return {
      intentId: "reference_to_video",
      methodId: "reference_to_video",
      mode: "start_frame",
    };
  }
  if (method === "video2video" || method === "vid2video") {
    return {
      intentId: "video_to_video",
      methodId: "video_to_video",
      mode: "start_frame",
    };
  }
  if (
    method === "replicate" ||
    method === "replicatepro" ||
    method === "replicatevideo"
  ) {
    const isVideo =
      opts.mediaType === "video" || method === "replicatevideo";
    if (isVideo) {
      return opts.hasInputImage
        ? {
            intentId: "image_to_video",
            methodId: "image_to_video",
            mode: "start_frame",
          }
        : {
            intentId: "text_to_video",
            methodId: "text_to_video",
            mode: "none",
          };
    }
    return opts.hasInputImage
      ? {
          intentId: "image_to_image",
          methodId: "image_to_image",
          mode: "start_frame",
        }
      : {
          intentId: "text_to_image",
          methodId: "text_to_image",
          mode: "none",
        };
  }

  // Unknown method with a prompt still counts as a generation — prefer still
  // vs video from media type so Result | Form can host a locked Form.
  if (opts.mediaType === "video") {
    return opts.hasInputImage
      ? {
          intentId: "image_to_video",
          methodId: "image_to_video",
          mode: "start_frame",
        }
      : {
          intentId: "text_to_video",
          methodId: "text_to_video",
          mode: "none",
        };
  }
  if (opts.mediaType === "image" || opts.mediaType === "") {
    return opts.hasInputImage
      ? {
          intentId: "image_to_image",
          methodId: "image_to_image",
          mode: "start_frame",
        }
      : {
          intentId: "text_to_image",
          methodId: "text_to_image",
          mode: "none",
        };
  }
  return null;
}

function deriveServerFromParasceneMeta(
  meta: Record<string, unknown>,
  method: string,
): "parascene_blue" | "replicate" {
  const serverId = meta.server_id;
  const serverName = asTrimmedString(meta.server_name).toLowerCase();
  if (
    serverId === 6 ||
    serverId === "6" ||
    serverName.includes("blue")
  ) {
    return "parascene_blue";
  }
  const methodLower = method.toLowerCase();
  if (
    methodLower === "replicate" ||
    methodLower === "replicatepro" ||
    methodLower === "replicatevideo"
  ) {
    // Parascene-hosted Replicate creates are stamped as parascene_blue by the
    // desktop library generate path — match that so Form server chips align.
    return "parascene_blue";
  }
  return "parascene_blue";
}

/**
 * Build AddAssetGeneration from Parascene cloud `meta.args` / `meta.method`
 * when no local desktop stamp exists. Enables Result | Form for creations
 * generated on Parascene (or via Parascene→Replicate) without a desktop stamp.
 */
export function deriveAddAssetGenerationFromParasceneMeta(
  creation: Pick<Creation, "id" | "remoteJson" | "prompt" | "createdAt" | "mediaType"> | null | undefined,
): AddAssetGeneration | null {
  if (!creation?.remoteJson?.trim() || !creation.id?.trim()) return null;
  try {
    const parsed = JSON.parse(creation.remoteJson) as Record<string, unknown>;
    const meta = asRecord(parsed.meta);
    if (!meta) return null;

    const method = asTrimmedString(meta.method);
    const args = asRecord(meta.args) ?? {};
    const inputImageUrl =
      firstInputImageUrl(args) ||
      asTrimmedString(meta.source_image_url) ||
      undefined;
    const mediaType = asTrimmedString(
      creation.mediaType ||
        meta.media_type ||
        parsed.media_type ||
        "",
    ).toLowerCase();

    const intent = deriveIntentFromParasceneMethod({
      method,
      hasInputImage: Boolean(inputImageUrl),
      mediaType,
    });
    if (!intent) return null;

    const prompt =
      asTrimmedString(args.prompt) ||
      asTrimmedString(meta.user_prompt) ||
      asTrimmedString(creation.prompt) ||
      "";
    // Generations always carry a prompt in practice; refuse empty so uploads
    // that somehow pass the method filter still stay out of Result | Form.
    if (!prompt) return null;

    const generatedAt =
      asTrimmedString(meta.completed_at) ||
      asTrimmedString(meta.started_at) ||
      asTrimmedString(creation.createdAt) ||
      asTrimmedString(parsed.created_at) ||
      new Date().toISOString();

    const model = asTrimmedString(args.model) || undefined;
    const server = deriveServerFromParasceneMeta(meta, method);

    const generation: AddAssetGeneration = {
      prompt,
      generatedAt,
      creationId: creation.id.trim(),
      mode: intent.mode,
      model,
      intentId: intent.intentId,
      server,
      provider: server,
      methodId: intent.methodId,
    };

    if (intent.mode === "start_frame" && inputImageUrl) {
      generation.startFramePreviewUrl = inputImageUrl;
      generation.firstFrameSource = { kind: "none" };
      generation.lastFrameSource = { kind: "none" };
    } else if (intent.mode === "none") {
      generation.firstFrameSource = { kind: "none" };
      generation.lastFrameSource = { kind: "none" };
    }

    return normalizeAddAssetGeneration(generation) ?? null;
  } catch {
    return null;
  }
}

/**
 * Intent stamped onto a finished timeline video gen.
 *
 * Prefer mode + model (video run → video intents). Use the draft only when it
 * already agrees — never copy a still intent onto an I2V/T2V result.
 */
export function stampIntentFromVideoRun(opts: {
  mode?: AddAssetGenerationMode | string | null;
  model?: string | null;
  draftIntentId?: string | null;
  draftMethodId?: string | null;
}): { intentId: string; methodId: string } {
  const model = (opts.model ?? "").trim().toLowerCase();
  const mode = (opts.mode ?? "").trim();
  const hasStartFrame =
    mode === "start_frame" ||
    mode === "first_last" ||
    mode === "motion_match";

  let inferred: string;
  if (
    model.includes("r2v") ||
    model.includes("reference2video") ||
    model.includes("_ingredients")
  ) {
    inferred = "reference_to_video";
  } else if (model.includes("v2v") || model.includes("video2video")) {
    inferred = "video_to_video";
  } else if (
    model.includes("_t2v") ||
    model.includes("t2v") ||
    model.includes("text2video") ||
    model.includes("txt2video")
  ) {
    inferred = "text_to_video";
  } else if (
    model.includes("_i2v") ||
    model.includes("i2v") ||
    model.includes("image2video") ||
    model.includes("img2video")
  ) {
    inferred = "image_to_video";
  } else if (mode === "none" || !hasStartFrame) {
    inferred = "text_to_video";
  } else {
    inferred = "image_to_video";
  }

  const draftIntent = opts.draftIntentId?.trim() || "";
  const draftMethod = opts.draftMethodId?.trim() || draftIntent;
  if (draftIntent && draftIntent === inferred) {
    return {
      intentId: draftIntent,
      methodId: draftMethod || draftIntent,
    };
  }
  return { intentId: inferred, methodId: inferred };
}

/**
 * Merge a desktop/timeline stamp with Parascene-derived provenance.
 *
 * When stamp intent/method disagrees with Creation meta (e.g. I2I stamp on an
 * `image2video` row), prefer derive for intent/method/model/mode. Keep stamp
 * frame ids and preview URLs — those are often the durable stills Form needs.
 */
export function mergeStampWithDerivedGeneration(
  stamp: AddAssetGeneration | null | undefined,
  creation:
    | Pick<Creation, "id" | "remoteJson" | "prompt" | "createdAt" | "mediaType">
    | null
    | undefined,
): AddAssetGeneration | null {
  const derived = deriveAddAssetGenerationFromParasceneMeta(creation);
  if (!stamp) return derived;

  const stampIntent =
    stamp.intentId?.trim() || stamp.methodId?.trim() || "";
  const derivedIntent =
    derived?.intentId?.trim() || derived?.methodId?.trim() || "";
  const intentConflict =
    Boolean(stampIntent) &&
    Boolean(derivedIntent) &&
    stampIntent !== derivedIntent;

  const merged: AddAssetGeneration = intentConflict && derived
    ? {
        ...stamp,
        intentId: derived.intentId,
        methodId: derived.methodId,
        model: derived.model ?? stamp.model,
        mode: derived.mode ?? stamp.mode,
      }
    : stamp;

  // Heal wrong-headed local-* FIRST stamps when Parascene meta already names
  // the still the model saw (input_images URL). Form must not point at a
  // throwaway extract that was only an upload bridge.
  const startId = merged.startFrameAssetId?.trim() || "";
  const isLocalStart = startId.startsWith("local-");
  if (!isLocalStart) return merged;
  if (!derived?.startFramePreviewUrl?.trim()) return merged;
  return {
    ...merged,
    startFrameAssetId: undefined,
    firstFrameSource: { kind: "none" },
    startFramePreviewUrl:
      merged.startFramePreviewUrl?.trim() || derived.startFramePreviewUrl,
  };
}

/**
 * Resolve generation provenance for UI: prefer a local desktop stamp (needed
 * for Direct-to-Blue / Replicate-direct), else derive from Parascene
 * `meta.args`. Sync preservation stays stamp-only via
 * {@link addAssetGenerationFromCreation}.
 */
export function resolveAddAssetGenerationFromCreation(
  creation:
    | Pick<Creation, "id" | "remoteJson" | "prompt" | "createdAt" | "mediaType">
    | null
    | undefined,
): AddAssetGeneration | null {
  return mergeStampWithDerivedGeneration(
    addAssetGenerationFromCreation(creation),
    creation,
  );
}

/**
 * Whether the catalog row should receive a `meta.desktop.addAssetGeneration`
 * stamp after generate.
 *
 * Parascene Creation-backed gens (`parascene_blue`) must **not** be stamped —
 * their API `meta` is the source of truth and must stay sync-identical.
 * Local-only servers need the stamp because they have no Parascene meta.
 */
export function shouldStampCatalogAddAssetGeneration(
  server: string | null | undefined,
): boolean {
  const id = server?.trim();
  if (!id) return false;
  if (id === "parascene_blue" || id === "parascene") return false;
  return id === "blue_direct" || id === "replicate";
}

/** Merge generation into remoteJson under meta.desktop (preserves other desktop keys). */
export function mergeAddAssetGenerationIntoRemoteJson(
  remoteJson: string | null | undefined,
  generation: AddAssetGeneration,
): string {
  let parsed: Record<string, unknown> = {};
  if (remoteJson?.trim()) {
    try {
      const value = JSON.parse(remoteJson) as unknown;
      if (value && typeof value === "object") {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }
  const meta =
    parsed.meta && typeof parsed.meta === "object"
      ? { ...(parsed.meta as Record<string, unknown>) }
      : {};
  const prevDesktop = desktopBlobFromParsed(parsed) ?? {};
  const desktop = {
    ...prevDesktop,
    client: "parascene-desktop",
    [ADD_ASSET_GENERATION_META_KEY]: generation,
  };
  meta[DESKTOP_GROUP_META_KEY] = desktop;
  return JSON.stringify({ ...parsed, meta });
}

/** Build a catalog upsert that carries generation provenance (+ fills empty prompt). */
export function creationUpsertWithAddAssetGeneration(
  creation: Creation,
  generation: AddAssetGeneration,
): CreationUpsert {
  const prompt =
    creation.prompt?.trim() || generation.prompt.trim() || null;
  return {
    id: creation.id,
    title: creation.title,
    mediaType: String(creation.mediaType),
    remoteUrl: creation.remoteUrl,
    thumbnailUrl: creation.thumbnailUrl,
    fitThumbnailUrl: creation.fitThumbnailUrl,
    videoUrl: creation.videoUrl,
    published: creation.published,
    publishedAt: creation.publishedAt,
    createdAt: creation.createdAt,
    downloadState: creation.downloadState,
    prompt,
    filename: creation.filename,
    description: creation.description,
    color: creation.color,
    status: creation.status,
    width: creation.width,
    height: creation.height,
    aspectRatio: creation.aspectRatio,
    nsfw: creation.nsfw,
    isModeratedError: creation.isModeratedError,
    remoteJson: mergeAddAssetGenerationIntoRemoteJson(
      creation.remoteJson,
      generation,
    ),
  };
}

/**
 * When syncing from the API, keep a prior local desktop generation stamp if
 * the remote snapshot does not include one.
 */
export function preserveDesktopAddAssetGeneration(
  upsert: CreationUpsert,
  existing: Creation | null | undefined,
): CreationUpsert {
  if (addAssetGenerationFromCreation({ remoteJson: upsert.remoteJson })) {
    return upsert;
  }
  const prior = addAssetGenerationFromCreation(existing);
  if (!prior) return upsert;
  return {
    ...upsert,
    prompt: upsert.prompt?.trim() || prior.prompt.trim() || upsert.prompt,
    remoteJson: mergeAddAssetGenerationIntoRemoteJson(upsert.remoteJson, prior),
  };
}

/** Provenance stamp for library Text → Image generates. */
export function makeTextToImageGeneration(opts: {
  prompt: string;
  creationId: string;
  model: string;
  server: "blue_direct" | "replicate" | "parascene_blue";
}): AddAssetGeneration {
  const server = opts.server;
  return {
    prompt: opts.prompt.trim(),
    generatedAt: new Date().toISOString(),
    creationId: opts.creationId.trim(),
    mode: "none",
    model: opts.model.trim(),
    intentId: "text_to_image",
    server,
    provider: server,
    methodId: "text_to_image",
  };
}

/** Provenance stamp for library Image → Image generates. */
export function makeImageToImageGeneration(opts: {
  prompt: string;
  creationId: string;
  model: string;
  server: "parascene_blue";
  sourceCreationId: string;
}): AddAssetGeneration {
  return {
    prompt: opts.prompt.trim(),
    generatedAt: new Date().toISOString(),
    creationId: opts.creationId.trim(),
    mode: "start_frame",
    model: opts.model.trim(),
    intentId: "image_to_image",
    server: opts.server,
    provider: opts.server,
    methodId: "image_to_image",
    startFrameAssetId: opts.sourceCreationId.trim(),
  };
}

export function isTextToImageGeneration(
  generation: AddAssetGeneration | null | undefined,
): boolean {
  if (!generation) return false;
  if (generation.intentId === "text_to_image") return true;
  if (generation.methodId === "text_to_image") return true;
  if (generation.methodId === "replicate_text_to_image") return true;
  return false;
}

export function isImageToImageGeneration(
  generation: AddAssetGeneration | null | undefined,
): boolean {
  if (!generation) return false;
  if (generation.intentId === "image_to_image") return true;
  if (generation.methodId === "image_to_image") return true;
  if (generation.methodId === "replicate_image_to_image") return true;
  return false;
}

/** Stable id for syncing locked review forms across asset switches. */
export function reviewGenerationIdentity(
  generation: AddAssetGeneration | null | undefined,
): string {
  if (!generation) return "";
  return (
    generation.creationId?.trim() ||
    generation.generatedAt?.trim() ||
    ""
  );
}
