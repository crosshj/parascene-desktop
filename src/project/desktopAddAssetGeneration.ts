/**
 * Persist editor Generate provenance on the catalog Creation
 * (`remoteJson.meta.desktop.addAssetGeneration`) so Assets-pane selection can
 * show the Generated badge even when the producing timeline clip is gone.
 */

import type { Creation, CreationUpsert } from "../library/types";
import { DESKTOP_GROUP_META_KEY } from "./desktopProjectGroups";
import type { AddAssetGeneration } from "./types";
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

/** Read generation provenance stamped on a catalog Creation. */
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
  server: "blue_direct" | "replicate";
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

export function isTextToImageGeneration(
  generation: AddAssetGeneration | null | undefined,
): boolean {
  if (!generation) return false;
  if (generation.intentId === "text_to_image") return true;
  if (generation.methodId === "text_to_image") return true;
  if (generation.methodId === "replicate_text_to_image") return true;
  return false;
}
