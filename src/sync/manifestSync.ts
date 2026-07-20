import { mapCatalogSyncError } from "../auth/errors";
import { createAuthedSdk, ensureAccessToken, getEnvConfig } from "../auth/session";
import { aspectRatioFromMeta } from "../library/aspectRatio";
import {
  applyManifest,
  cloudIdsSince,
  deleteLocal,
  downloadPending,
  existingCreationIds,
  getSyncStatus,
} from "../library/catalogClient";
import {
  groupEmbeddedSourceCreations,
  isGroupCreation,
} from "../library/creationFlags";
import { CREATIONS_PAGE_SIZE, type CreationUpsert, type SyncStatus } from "../library/types";
import {
  absolutizeAssetUrl,
  deriveFitThumbnailUrl,
  type RemoteCreateImage,
} from "../sdk/parascene";

/** Page size for newest-first catalog sync (`created_at DESC`). Match website-ish pages. */
export const NEWEST_SYNC_PAGE_SIZE = 50;
/** Hard cap — "newest" must not walk the whole catalog (use Full sync for that). */
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
    rethrowCatalogError(e);
  }

  return all.map(mapRemoteCreation);
}

async function warmAheadPreviews(status?: SyncStatus): Promise<SyncStatus> {
  const summary = await downloadPending(CREATIONS_PAGE_SIZE);
  return summary.status ?? status ?? (await getSyncStatus());
}

/** Kick thumb warm-ahead without blocking the Sync button / UI. */
function kickWarmAheadPreviews(): void {
  void warmAheadPreviews().catch(() => {
    /* background */
  });
}

/** Metadata only (full image records) — no media downloads. */
export async function syncCreationsMetadata(): Promise<SyncStatus> {
  const creations = await fetchAllRemoteCreations();
  return applyManifest(creations);
}

/**
 * Newest-first catalog sync: fetch a small newest window (default 2×50),
 * apply only unknown ids, stop early once a page is already fully local.
 * Also drops local rows that should have appeared in that recent window but
 * are gone on Parascene (verified with getCreation) — capped to the last
 * {@link NEWEST_PRUNE_MAX_AGE_MS}. Older removals still need Full sync.
 */
export async function syncNewestCreationsManifest(opts?: {
  onProgress?: (progress: NewestSyncProgress) => void;
}): Promise<NewestSyncResult> {
  const target = NEWEST_SYNC_PAGE_SIZE * NEWEST_SYNC_MAX_PAGES;
  let added = 0;
  let pruned = 0;
  const report = (
    phase: NewestSyncProgress["phase"],
    message: string,
    checked: number,
  ) => {
    opts?.onProgress?.({
      phase,
      message,
      checked,
      target,
      added,
      pruned,
    });
  };

  report("auth", "Checking session…", 0);
  try {
    await ensureAccessToken();
  } catch (e: unknown) {
    rethrowCatalogError(e);
  }

  report("fetch", "Fetching newest…", 0);
  const sdk = createAuthedSdk();
  let offset = 0;
  let lastStatus: SyncStatus | null = null;
  let pages = 0;
  const remoteRows: CreationUpsert[] = [];

  try {
    for (;;) {
      if (pages >= NEWEST_SYNC_MAX_PAGES) break;

      const pageNum = pages + 1;
      report(
        "fetch",
        `Fetching page ${pageNum} of ${NEWEST_SYNC_MAX_PAGES}…`,
        remoteRows.length,
      );
      const page = await sdk.listMyCreations({
        limit: NEWEST_SYNC_PAGE_SIZE,
        offset,
      });
      pages += 1;
      if (page.images.length === 0) break;

      const upserts = page.images.map(mapRemoteCreation);
      remoteRows.push(...upserts);
      const checked = remoteRows.length;
      report(
        "fetch",
        `Checked ${checked} of ~${target} newest…`,
        checked,
      );

      const ids = upserts.map((c) => c.id);
      const existing = new Set(await existingCreationIds(ids));
      const newRows = upserts.filter((c) => !existing.has(c.id));

      if (newRows.length > 0) {
        report(
          "apply",
          `Saving ${newRows.length} new creation(s) (${checked} of ~${target})…`,
          checked,
        );
        lastStatus = await applyManifest(newRows);
        added += newRows.length;
        report(
          "apply",
          `Added ${added} so far · checked ${checked} of ~${target}`,
          checked,
        );
      }

      // Caught up: every id on this page is already local.
      const allKnown = upserts.every((c) => existing.has(c.id));
      if (allKnown) {
        report(
          "fetch",
          `Caught up · checked ${checked} of ~${target}`,
          checked,
        );
        break;
      }
      if (!page.hasMore || page.images.length === 0) break;

      offset += page.images.length;
    }
  } catch (e: unknown) {
    rethrowCatalogError(e);
  }

  if (remoteRows.length > 0) {
    report(
      "prune",
      `Checking recent deletions (${remoteRows.length} of ~${target})…`,
      remoteRows.length,
    );
    pruned = await pruneRecentRemoteDeletions(sdk, remoteRows, (done, total) => {
      report(
        "prune",
        total > 0
          ? `Removing deleted locally ${done} of ${total}…`
          : "No recent deletions to clear",
        remoteRows.length,
      );
    });
  }

  if (!lastStatus) {
    // Touch sync timestamp so "last synced" updates on a no-op newest pass.
    lastStatus = await applyManifest([]);
  } else if (pruned > 0) {
    lastStatus = await getSyncStatus();
  }

  report(
    "done",
    added > 0 || pruned > 0
      ? `Done · added ${added}, removed ${pruned}`
      : `Done · nothing new in newest ~${target}`,
    remoteRows.length || target,
  );
  kickWarmAheadPreviews();
  return { status: lastStatus, added, pruned };
}

/**
 * Remove local cloud rows that belong in the fetched newest window but are
 * missing remotely (deleted on Parascene recently).
 */
async function pruneRecentRemoteDeletions(
  sdk: ReturnType<typeof createAuthedSdk>,
  remoteRows: CreationUpsert[],
  onTick?: (done: number, total: number) => void,
): Promise<number> {
  const remoteIds = new Set(remoteRows.map((r) => r.id));
  let oldestInWindow = remoteRows[0]?.createdAt ?? null;
  for (const row of remoteRows) {
    if (!oldestInWindow || row.createdAt < oldestInWindow) {
      oldestInWindow = row.createdAt;
    }
  }
  if (!oldestInWindow) return 0;

  const sinceIso = recentPruneSinceIso(oldestInWindow);
  const locals = await cloudIdsSince(sinceIso);
  const candidates = locals
    .map((row) => row.id)
    .filter((id) => !remoteIds.has(id));
  if (candidates.length === 0) {
    onTick?.(0, 0);
    return 0;
  }

  let pruned = 0;
  let checked = 0;
  for (const id of candidates) {
    checked += 1;
    onTick?.(checked, candidates.length);
    try {
      await sdk.getCreation(id);
      // Still on Parascene (outside the pages we fetched, or race) — keep.
    } catch {
      try {
        await deleteLocal(id);
        pruned += 1;
      } catch {
        /* keep going */
      }
    }
  }
  return pruned;
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
 * Exhaustive catalog sync: fetch every creation page and upsert the full
 * manifest. Use for edits, removals, and recovery after newest-only sync.
 */
export async function syncFullCreationsManifest(): Promise<SyncStatus> {
  const creations = await fetchAllRemoteCreations();
  const status = await applyManifest(creations);
  kickWarmAheadPreviews();
  return status;
}

/**
 * Pull full creations metadata into SQLite, then kick backend thumb warm-ahead
 * (several pages). Media trails thumbs and must not block the board.
 *
 * Alias for {@link syncFullCreationsManifest} (recovery / onboarding path).
 */
export async function syncCreationsManifest(): Promise<SyncStatus> {
  return syncFullCreationsManifest();
}
