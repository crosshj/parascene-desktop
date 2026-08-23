/**
 * One path for Form start/last still previews — every intent, locked or not.
 * Output modality (still vs video) does not get a separate preview pipeline.
 */

import { getCreations } from "../library/catalogClient";
import { creationPreviewUrl } from "../library/previewUrl";
import type { Creation } from "../library/types";
import {
  frameSourceAssetId,
  resolveFirstFrameSource,
  resolveLastFrameSource,
} from "./addAssetFrameSource";
import type { AddAssetGeneration } from "./types";


/** Normalize for matching Parascene input_images URLs to Creation.remoteUrl. */
export function normalizeCreationRemoteUrl(url: string): string {
  return url.trim().replace(/\/$/, "").split("?")[0] ?? "";
}

/**
 * Find a Creation whose remoteUrl matches an input_images / share URL.
 * Used to heal Form FIRST from URL-only Parascene meta to a Creation id.
 */
export function matchCreationIdByRemoteUrl(
  url: string | null | undefined,
  creations:
    | Iterable<Pick<Creation, "id" | "remoteUrl">>
    | ReadonlyMap<string, Pick<Creation, "id" | "remoteUrl">>
    | Readonly<Record<string, Pick<Creation, "id" | "remoteUrl">>>
    | null
    | undefined,
): string | null {
  const needle = normalizeCreationRemoteUrl(url ?? "");
  if (!needle || !creations) return null;
  const rows: Iterable<Pick<Creation, "id" | "remoteUrl">> =
    creations instanceof Map
      ? creations.values()
      : Array.isArray(creations)
        ? creations
        : Object.values(creations as Record<string, Pick<Creation, "id" | "remoteUrl">>);
  for (const row of rows) {
    const remote = normalizeCreationRemoteUrl(row.remoteUrl ?? "");
    if (remote && remote === needle) return row.id.trim() || null;
  }
  return null;
}

export type GenerationFramePreviews = {
  startAssetId: string | null;
  endAssetId: string | null;
  /** Sync best-effort — stamp URL and/or already-loaded Creation row. */
  startPreviewUrl: string | null;
  endPreviewUrl: string | null;
};

function creationFromBag(
  id: string,
  creationsById?:
    | ReadonlyMap<string, Creation>
    | Readonly<Record<string, Creation>>,
): Creation | undefined {
  if (!creationsById) return undefined;
  if (creationsById instanceof Map) return creationsById.get(id);
  return (creationsById as Readonly<Record<string, Creation>>)[id];
}

function previewFromCreation(creation: Creation | undefined): string | null {
  if (!creation) return null;
  return creationPreviewUrl(creation)?.trim() || null;
}

/**
 * Sync resolve: stamped preview URLs first, then asset ids (optionally
 * enriched from an in-memory Creation map).
 */
export function resolveGenerationFramePreviews(
  generation: AddAssetGeneration | null | undefined,
  creationsById?:
    | ReadonlyMap<string, Creation>
    | Readonly<Record<string, Creation>>,
): GenerationFramePreviews {
  if (!generation) {
    return {
      startAssetId: null,
      endAssetId: null,
      startPreviewUrl: null,
      endPreviewUrl: null,
    };
  }

  const first = resolveFirstFrameSource({
    firstFrameSource: generation.firstFrameSource,
    startFrameAssetId: generation.startFrameAssetId,
  });
  const last = resolveLastFrameSource({
    lastFrameSource: generation.lastFrameSource,
    continuityMode: generation.mode,
  });

  const stampedStart = generation.startFramePreviewUrl?.trim() || null;
  const stampedEnd = generation.endFramePreviewUrl?.trim() || null;

  let startAssetId =
    frameSourceAssetId(first) ||
    generation.startFrameAssetId?.trim() ||
    null;
  // Throwaway local-* extracts are never durable Parascene FIRST identity.
  if (startAssetId?.startsWith("local-")) startAssetId = null;
  if (!startAssetId && stampedStart) {
    startAssetId = matchCreationIdByRemoteUrl(stampedStart, creationsById);
  }
  const endAssetId = frameSourceAssetId(last);

  const startPreviewUrl =
    stampedStart ||
    (startAssetId
      ? previewFromCreation(creationFromBag(startAssetId, creationsById))
      : null);
  const endPreviewUrl =
    stampedEnd ||
    (endAssetId
      ? previewFromCreation(creationFromBag(endAssetId, creationsById))
      : null);

  return {
    startAssetId,
    endAssetId,
    startPreviewUrl,
    endPreviewUrl,
  };
}

/**
 * Catalog hop for asset ids that still lack a preview URL.
 * Always safe to call on locked Form review.
 */
export async function loadGenerationFramePreviews(
  generation: AddAssetGeneration | null | undefined,
): Promise<GenerationFramePreviews> {
  const base = resolveGenerationFramePreviews(generation);
  const missingIds = [
    !base.startPreviewUrl && base.startAssetId ? base.startAssetId : null,
    !base.endPreviewUrl && base.endAssetId ? base.endAssetId : null,
  ].filter((id): id is string => Boolean(id));

  if (missingIds.length === 0) return base;

  try {
    const rows = await getCreations(missingIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return resolveGenerationFramePreviews(generation, byId);
  } catch {
    return base;
  }
}
