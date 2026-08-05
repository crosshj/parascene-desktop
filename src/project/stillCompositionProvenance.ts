import type { Creation, CreationUpsert } from "../library/types";
import { DESKTOP_GROUP_META_KEY } from "./desktopProjectGroups";

export const STILL_COMPOSITION_ORIGIN_META_KEY = "stillCompositionOrigin";

export type StillCompositionOrigin = {
  compositionId: string;
  runNodeId: string;
  sourceCreationId: string;
  promotedAt: string;
  prompt?: string;
  model?: string;
};

function mergeOrigin(
  remoteJson: string | null | undefined,
  origin: StillCompositionOrigin,
): string {
  let parsed: Record<string, unknown> = {};
  try {
    const value = remoteJson?.trim() ? JSON.parse(remoteJson) : null;
    if (value && typeof value === "object") parsed = value;
  } catch {
    // Local imports normally have no remote JSON.
  }
  const meta =
    parsed.meta && typeof parsed.meta === "object"
      ? { ...(parsed.meta as Record<string, unknown>) }
      : {};
  const desktop =
    meta[DESKTOP_GROUP_META_KEY] &&
    typeof meta[DESKTOP_GROUP_META_KEY] === "object"
      ? { ...(meta[DESKTOP_GROUP_META_KEY] as Record<string, unknown>) }
      : {};
  desktop.client = "parascene-desktop";
  desktop[STILL_COMPOSITION_ORIGIN_META_KEY] = origin;
  meta[DESKTOP_GROUP_META_KEY] = desktop;
  return JSON.stringify({ ...parsed, meta });
}

export function creationUpsertWithStillCompositionOrigin(
  creation: Creation,
  origin: StillCompositionOrigin,
): CreationUpsert {
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
    prompt: creation.prompt,
    filename: creation.filename,
    description: creation.description,
    color: creation.color,
    status: creation.status,
    width: creation.width,
    height: creation.height,
    aspectRatio: creation.aspectRatio,
    nsfw: creation.nsfw,
    isModeratedError: creation.isModeratedError,
    remoteJson: mergeOrigin(creation.remoteJson, origin),
  };
}
