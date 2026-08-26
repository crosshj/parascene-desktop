import { mapCatalogSyncError } from "../auth/errors";
import { ensureAccessToken, getEnvConfig } from "../auth/session";
import { runSyncFull, runSyncNewest } from "../services/syncCatalog";
import { aspectRatioFromMeta } from "../library/aspectRatio";
import {
  applyManifest,
  getSyncStatus,
  listCreations,
} from "../library/catalogClient";
import {
  groupEmbeddedSourceCreations,
  isGroupCreation,
} from "../library/creationFlags";
import { type CreationUpsert, type SyncStatus } from "../library/types";
import {
  absolutizeAssetUrl,
  deriveFitThumbnailUrl,
  type RemoteCreateImage,
} from "../sdk/parascene";
import { syncSessionUserAvatar } from "./avatarSync";

/** Page size for newest-first catalog sync (`created_at DESC`). Match website-ish pages. */
export const NEWEST_SYNC_PAGE_SIZE = 50;
/** Hard cap — "newest" must not walk the whole catalog (use Sync full catalog for that). */
export const NEWEST_SYNC_MAX_PAGES = 2;
/** Only prune local rows that fall inside this recent window (and the fetched newest pages). */
export const NEWEST_PRUNE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type NewestSyncResult = {
  status: SyncStatus;
  /** Newly applied remote ids. */
  added: number;
  /** Local rows removed after confirming they are gone on Parascene. */
  pruned: number;
};

export type NewestSyncProgress = {
  phase: "auth" | "fetch" | "apply" | "prune" | "done";
  /** Human-readable step for the status banner. */
  message: string;
  /** Creations inspected from Parascene so far. */
  checked: number;
  /** Soft target for the newest window (usually 100). */
  target: number;
  added: number;
  pruned: number;
};

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
 * Parascene is still producing this creation — do not catalog-sync yet.
 * Matches `creating` and prefixed variants (e.g. `creating_video`).
 */
export function isCreatingRemoteStatus(
  status: string | null | undefined,
): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "creating" || s.startsWith("creating");
}

function isSyncableRemoteCreation(
  creation: Pick<CreationUpsert, "status">,
): boolean {
  return !isCreatingRemoteStatus(creation.status);
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
  const fitThumbnailUrl =
    optionalString(source.fit_thumbnail_url) ??
    deriveFitThumbnailUrl(thumbnailUrl, url);
  // Embedded i2v members often only carry the poster `file_path`, not video_url.
  let videoUrl = optionalString(source.video_url);
  if (!videoUrl && mediaType === "video" && filePath) {
    const poster = filePath.match(/\/api\/images\/created\/(.+)\.png$/i);
    if (poster) {
      videoUrl = `/api/videos/created/video/${poster[1]}.mp4`;
    }
  }

  return {
    ...source,
    id,
    url,
    thumbnail_url: thumbnailUrl,
    fit_thumbnail_url: fitThumbnailUrl,
    video_url: videoUrl,
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
    const upsert = mapRemoteCreation(remote);
    if (!isSyncableRemoteCreation(upsert)) continue;
    seen.add(id);
    out.push(upsert);
  }
  return out;
}

/**
 * Append catalog rows for group members embedded in group covers that the API
 * did not return as standalone creations. Existing standalone rows win — real
 * API records are richer than the denormalized `source_creations` snapshot.
 *
 * Used on demand when opening a group (lightbox / editor), and by
 * {@link syncGroupMembersManifest}. Sync full catalog does **not** expand
 * members on its own.
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

export type GroupMembersSyncResult = {
  status: SyncStatus;
  /** Local group cover rows inspected. */
  groups: number;
  /** Member rows newly upserted into the catalog. */
  added: number;
};

/**
 * Upsert group members from embedded `source_creations` on local group covers.
 * Covers must already be in the catalog (run Sync full catalog first).
 * Does not call Parascene — members come from cover JSON already synced locally.
 */
export async function syncGroupMembersManifest(): Promise<GroupMembersSyncResult> {
  const all = await listCreations();
  const groups = all.filter((c) => isGroupCreation(c));
  const existing = new Set(all.map((c) => c.id));
  const additions: CreationUpsert[] = [];
  const addedIds = new Set<string>();
  for (const group of groups) {
    const members = mapGroupSourceCreations(groupEmbeddedSourceCreations(group));
    for (const member of members) {
      if (existing.has(member.id) || addedIds.has(member.id)) continue;
      addedIds.add(member.id);
      additions.push(member);
    }
  }
  if (additions.length === 0) {
    return {
      status: await getSyncStatus(),
      groups: groups.length,
      added: 0,
    };
  }
  const status = await applyManifest(additions);
  return { status, groups: groups.length, added: additions.length };
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
    absolutizeAssetUrl(img.fit_thumbnail_url || undefined, origin) ??
    deriveFitThumbnailUrl(thumbnailUrl, url) ??
    null;
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

function rethrowCatalogError(e: unknown): never {
  throw mapCatalogSyncError(e);
}

/** Metadata only (full image records) — no media downloads. */
export async function syncCreationsMetadata(): Promise<SyncStatus> {
  const result = await runSyncFull();
  return result.status;
}

/**
 * Newest-first catalog sync via Rust job. Prefer {@link runSyncNewest} from
 * `src/services/syncCatalog.ts` in new code.
 */
export async function syncNewestCreationsManifest(opts?: {
  onProgress?: (progress: NewestSyncProgress) => void;
}): Promise<NewestSyncResult> {
  const target = NEWEST_SYNC_PAGE_SIZE * NEWEST_SYNC_MAX_PAGES;
  try {
    await ensureAccessToken();
  } catch (e: unknown) {
    rethrowCatalogError(e);
  }
  await syncSessionUserAvatar();
  const result = await runSyncNewest({
    onProgress: (p) => {
      opts?.onProgress?.({
        phase: p.phase === "done" ? "done" : "fetch",
        message: p.message,
        checked: p.checked ?? 0,
        target,
        added: p.added ?? 0,
        pruned: p.pruned ?? 0,
      });
    },
  });
  return {
    status: result.status,
    added: result.added,
    pruned: result.pruned,
  };
}

/** Prefer the newest-page floor, but never look further back than a few hours. */
export function recentPruneSinceIso(
  oldestFetchedCreatedAt: string,
  nowMs = Date.now(),
): string {
  const floorMs = Date.parse(oldestFetchedCreatedAt);
  const recentFloor = new Date(nowMs - NEWEST_PRUNE_MAX_AGE_MS).toISOString();
  if (!Number.isFinite(floorMs)) return recentFloor;
  const fetchedFloor = new Date(floorMs).toISOString();
  return fetchedFloor > recentFloor ? fetchedFloor : recentFloor;
}

/**
 * Exhaustive catalog sync via Rust job. Prefer {@link runSyncFull} from
 * `src/services/syncCatalog.ts` in new code.
 */
export async function syncFullCreationsManifest(): Promise<SyncStatus> {
  try {
    await ensureAccessToken();
  } catch (e: unknown) {
    rethrowCatalogError(e);
  }
  await syncSessionUserAvatar();
  const result = await runSyncFull();
  return result.status;
}

/**
 * Page the catalog until each wanted id is found (or pages are exhausted) and
 * upsert those rows. Used after newest sync to refresh project group covers
 * that may sit outside the newest window.
 *
 * Detail `GET /api/create/images/:id` often omits `meta.group`, so list pages
 * are the reliable source for membership.
 */
export async function refreshCreationsFromListById(
  ids: readonly string[],
  opts?: { maxPages?: number; pageSize?: number },
): Promise<number> {
  const { refreshCreationsFromListById: refreshViaService } = await import(
    "../services/syncCatalog"
  );
  return refreshViaService(ids, opts);
}

/**
 * Pull full creations metadata into SQLite.
 *
 * Alias for {@link syncFullCreationsManifest} (recovery / onboarding path).
 */
export async function syncCreationsManifest(): Promise<SyncStatus> {
  return syncFullCreationsManifest();
}
