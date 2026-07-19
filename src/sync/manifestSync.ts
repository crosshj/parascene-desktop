import { createAuthedSdk, ensureAccessToken, getEnvConfig } from "../auth/session";
import { aspectRatioFromMeta } from "../library/aspectRatio";
import {
  applyManifest,
  downloadPending,
} from "../library/catalogClient";
import {
  groupEmbeddedSourceCreations,
  isGroupCreation,
} from "../library/creationFlags";
import { CREATIONS_PAGE_SIZE, type CreationUpsert, type SyncStatus } from "../library/types";
import { absolutizeAssetUrl, type RemoteCreateImage } from "../sdk/parascene";

function promptFromMeta(meta: RemoteCreateImage["meta"]): string | null {
  if (!meta || typeof meta !== "object") return null;
  if (typeof meta.prompt === "string" && meta.prompt.trim()) {
    return meta.prompt.trim();
  }
  const args = meta.args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const prompt = (args as { prompt?: unknown }).prompt;
    if (typeof prompt === "string" && prompt.trim()) return prompt.trim();
  }
  return null;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

function mediaOrigin(): string {
  return getEnvConfig().baseUrl;
}

/**
 * Turn an embedded group `source_creations[]` row into a RemoteCreateImage.
 * Group members often only have `file_path` (no top-level `url`).
 */
export function remoteFromGroupSource(
  source: Record<string, unknown>,
): RemoteCreateImage | null {
  const id = idFromUnknown(source.id);
  if (!id) return null;

  const meta =
    source.meta && typeof source.meta === "object" && !Array.isArray(source.meta)
      ? (source.meta as Record<string, unknown>)
      : null;
  const filePath = optionalString(source.file_path);
  const url =
    optionalString(source.url) ??
    optionalString(source.image_url) ??
    filePath;
  const mediaType =
    optionalString(source.media_type) ??
    optionalString(meta?.media_type) ??
    (optionalString(source.video_url) ? "video" : "image");
  const thumbnailUrl =
    optionalString(source.thumbnail_url) ??
    (filePath ? `${filePath}?variant=thumbnail` : null);

  return {
    ...source,
    id,
    url,
    thumbnail_url: thumbnailUrl,
    video_url: optionalString(source.video_url),
    media_type: mediaType,
    filename: optionalString(source.filename),
    title: optionalString(source.title),
    description: optionalString(source.description),
    published: source.published === true,
    published_at: optionalString(source.published_at),
    created_at: optionalString(source.created_at),
    status: optionalString(source.status) ?? "completed",
    width: source.width as number | null | undefined,
    height: source.height as number | null | undefined,
    color: optionalString(source.color),
    nsfw: source.nsfw === true,
    is_moderated_error: source.is_moderated_error === true,
    meta,
  };
}

function idFromUnknown(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

/** Catalog upserts for group members missing as standalone library rows. */
export function mapGroupSourceCreations(
  sources: ReadonlyArray<Record<string, unknown>>,
): CreationUpsert[] {
  const out: CreationUpsert[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const remote = remoteFromGroupSource(source);
    if (!remote) continue;
    const id = String(remote.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(mapRemoteCreation(remote));
  }
  return out;
}

/**
 * Append catalog rows for group members embedded in group covers that the API
 * did not return as standalone creations. Existing standalone rows win — real
 * API records are richer than the denormalized `source_creations` snapshot.
 *
 * Used on demand when opening a group (lightbox / editor). Full library sync
 * does **not** expand members onto the Creations board.
 */
export function withEmbeddedGroupMembers(
  creations: CreationUpsert[],
): CreationUpsert[] {
  const byId = new Map(creations.map((c) => [c.id, c]));
  const additions: CreationUpsert[] = [];
  const addedIds = new Set<string>();
  for (const creation of creations) {
    if (!isGroupCreation({ remoteJson: creation.remoteJson, filename: creation.filename })) {
      continue;
    }
    const members = mapGroupSourceCreations(
      groupEmbeddedSourceCreations({ remoteJson: creation.remoteJson }),
    );
    for (const member of members) {
      if (byId.has(member.id) || addedIds.has(member.id)) continue;
      addedIds.add(member.id);
      additions.push(member);
    }
  }
  return additions.length > 0 ? [...creations, ...additions] : creations;
}

/**
 * Map a Parascene create-images row into a catalog upsert.
 * Keeps a full JSON copy of the (URL-absolutized) API object plus denormalized fields.
 */
export function mapRemoteCreation(img: RemoteCreateImage): CreationUpsert {
  const id = String(img.id);
  const mediaType =
    (typeof img.media_type === "string" && img.media_type) ||
    (img.video_url ? "video" : "image");
  const origin = mediaOrigin();
  const url =
    absolutizeAssetUrl(img.url || undefined, origin) ?? null;
  const thumbnailUrl =
    absolutizeAssetUrl(img.thumbnail_url || undefined, origin) ?? null;
  const fitThumbnailUrl =
    absolutizeAssetUrl(img.fit_thumbnail_url || undefined, origin) ?? null;
  const videoUrl =
    absolutizeAssetUrl(img.video_url || undefined, origin) ?? null;
  const remoteUrl =
    (mediaType === "video" ? videoUrl || url : url || videoUrl) ?? null;
  const filename = optionalString(img.filename);
  const title =
    optionalString(img.title) || filename || `Creation ${id}`;
  const width = positiveInt(img.width);
  const height = positiveInt(img.height);
  const aspectRatio =
    aspectRatioFromMeta(img.meta) ??
    (width && height ? `${width}:${height}` : null);

  // Full cloud snapshot — every image-related field from the API response.
  const remoteSnapshot: Record<string, unknown> = {
    ...img,
    id,
    url,
    thumbnail_url: thumbnailUrl,
    fit_thumbnail_url: fitThumbnailUrl,
    video_url: videoUrl,
    media_type: mediaType,
    width,
    height,
    filename,
    title: optionalString(img.title),
    description: optionalString(img.description),
    color: optionalString(img.color),
    status: optionalString(img.status) ?? "completed",
    published: img.published === true,
    published_at: optionalString(img.published_at),
    created_at: optionalString(img.created_at),
    nsfw: img.nsfw === true,
    is_moderated_error: img.is_moderated_error === true,
    meta: img.meta ?? null,
  };

  return {
    id,
    title,
    mediaType,
    remoteUrl,
    thumbnailUrl,
    fitThumbnailUrl,
    videoUrl,
    published: img.published === true,
    publishedAt: optionalString(img.published_at),
    createdAt: optionalString(img.created_at) || new Date().toISOString(),
    downloadState: "remote",
    prompt: promptFromMeta(img.meta),
    filename,
    description: optionalString(img.description),
    color: optionalString(img.color),
    status: optionalString(img.status) ?? "completed",
    width,
    height,
    aspectRatio,
    nsfw: img.nsfw === true,
    isModeratedError: img.is_moderated_error === true,
    remoteJson: JSON.stringify(remoteSnapshot),
  };
}

async function fetchAllRemoteCreations(): Promise<CreationUpsert[]> {
  await ensureAccessToken();
  const sdk = createAuthedSdk();
  const pageSize = 100;
  const all: RemoteCreateImage[] = [];
  let offset = 0;

  try {
    for (;;) {
      const page = await sdk.listMyCreations({ limit: pageSize, offset });
      all.push(...page.images);
      if (!page.hasMore || page.images.length === 0) break;
      offset += page.images.length;
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (/unauthorized/i.test(message)) {
      throw new Error(
        "Parascene rejected the session (Unauthorized). Try logging out and back in, then Sync again.",
      );
    }
    throw e;
  }

  return all.map(mapRemoteCreation);
}

/** Metadata only (full image records) — no media downloads. */
export async function syncCreationsMetadata(): Promise<SyncStatus> {
  const creations = await fetchAllRemoteCreations();
  return applyManifest(creations);
}

/**
 * Pull full creations metadata into SQLite, then kick backend thumb warm-ahead
 * (several pages). Media trails thumbs and must not block the board.
 */
export async function syncCreationsManifest(): Promise<SyncStatus> {
  const creations = await fetchAllRemoteCreations();
  await applyManifest(creations);
  const summary = await downloadPending(CREATIONS_PAGE_SIZE);
  return summary.status;
}
