/**
 * Thin invoke wrappers over the local catalog (SQLite) and download workers.
 *
 * UI paints local disk paths only. Missing assets: `ensureLocal` → Rust saves
 * to disk → `library-creation-updated` → paint. Never load remote media URLs.
 */
import { invoke } from "@tauri-apps/api/core";
import { ensureAccessToken } from "../auth/session";
import { preserveDesktopAddAssetGeneration } from "../project/desktopAddAssetGeneration";
import type {
  Creation,
  CatalogFilterCounts,
  CreationPage,
  CreationUpsert,
  DownloadSummary,
  SyncStatus,
} from "./types";
import { CREATIONS_PAGE_SIZE } from "./types";

export async function ensureLibraryReady(): Promise<SyncStatus> {
  return invoke<SyncStatus>("library_ensure_ready");
}

export async function listCreations(): Promise<Creation[]> {
  return invoke<Creation[]>("library_list_creations");
}

export async function listCreationsPage(opts?: {
  limit?: number;
  offset?: number;
}): Promise<CreationPage> {
  return invoke<CreationPage>("library_list_creations_page", {
    limit: opts?.limit ?? CREATIONS_PAGE_SIZE,
    offset: opts?.offset ?? 0,
  });
}

export async function getCatalogFilterCounts(): Promise<CatalogFilterCounts> {
  return invoke<CatalogFilterCounts>("library_filter_counts");
}

/** Sparse filters that must list from SQLite (not the newest-page window). */
export type CatalogListFilterId = "audio" | "localOnly";

export function isCatalogListFilterId(
  id: string,
): id is CatalogListFilterId {
  return id === "audio" || id === "localOnly";
}

/**
 * Full match set for Audio / Local-only — not limited to already-loaded newest pages.
 */
export async function listCreationsForFilter(
  filter: CatalogListFilterId,
): Promise<Creation[]> {
  return invoke<Creation[]>("library_list_filter_creations", { filter });
}

/**
 * Keep `primary` order; append any `extras` whose ids are missing
 * (extras sorted newest-first to match catalog order).
 */
export function mergeCreationsById(
  primary: readonly Creation[],
  extras: readonly Creation[],
): Creation[] {
  if (extras.length === 0) return [...primary];
  const seen = new Set(primary.map((c) => c.id));
  const missing = extras.filter((c) => !seen.has(c.id));
  if (missing.length === 0) return [...primary];
  const sorted = [...missing].sort((a, b) => {
    const byCreated = b.createdAt.localeCompare(a.createdAt);
    if (byCreated !== 0) return byCreated;
    return a.title.localeCompare(b.title);
  });
  return [...primary, ...sorted];
}

/** Creation ids that belong inside a group cover — hidden from the board / media filters. */
export async function listGroupMemberIds(): Promise<string[]> {
  return invoke<string[]>("library_list_group_member_ids");
}

export async function getCreation(id: string): Promise<Creation> {
  return invoke<Creation>("library_get_creation", { id });
}

/** Fetch creations by id, preserving `ids` order. Missing rows are skipped. */
export async function getCreations(ids: string[]): Promise<Creation[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const rows = await invoke<Creation[]>("library_get_creations", { ids: unique });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: Creation[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("library_sync_status");
}

/** Which of the given creation ids already exist in the local catalog. */
export async function existingCreationIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  return invoke<string[]>("library_existing_creation_ids", { ids });
}

/** Cloud (non-local) creation ids with createdAt >= sinceIso. */
export async function cloudIdsSince(
  sinceIso: string,
): Promise<Array<{ id: string; createdAt: string }>> {
  if (!sinceIso.trim()) return [];
  return invoke("library_cloud_ids_since", { sinceIso });
}

export async function applyManifest(
  creations: CreationUpsert[],
): Promise<SyncStatus> {
  if (creations.length === 0) {
    return invoke<SyncStatus>("library_apply_manifest", { creations });
  }
  // Preserve locally stamped desktop generation meta across cloud sync upserts.
  const existing = await getCreations(creations.map((row) => row.id));
  const byId = new Map(existing.map((row) => [row.id, row]));
  const merged = creations.map((row) =>
    preserveDesktopAddAssetGeneration(row, byId.get(row.id)),
  );
  return invoke<SyncStatus>("library_apply_manifest", { creations: merged });
}

export async function downloadPending(limit?: number): Promise<DownloadSummary> {
  return invoke<DownloadSummary>("library_download_pending", {
    limit: limit ?? null,
  });
}

export async function downloadIds(ids: string[]): Promise<DownloadSummary> {
  if (ids.length === 0) {
    return {
      downloaded: 0,
      failed: 0,
      skipped: 0,
      status: await getSyncStatus(),
    };
  }
  return invoke<DownloadSummary>("library_download_ids", { ids });
}

/** Ask Rust to priority-save creations locally. */
export async function ensureLocal(
  ids: string[],
  opts?: { fullMedia?: boolean; urgent?: boolean },
): Promise<void> {
  if (ids.length === 0) return;
  await invoke<void>("library_ensure_local", {
    ids,
    fullMedia: opts?.fullMedia ?? false,
    urgent: opts?.urgent ?? false,
  });
}

/** Prefetch thumbs for off-screen rows already in the loaded catalog window. */
export async function downloadThumbs(ids: string[]): Promise<DownloadSummary> {
  if (ids.length === 0) {
    return {
      downloaded: 0,
      failed: 0,
      skipped: 0,
      status: await getSyncStatus(),
    };
  }
  return invoke<DownloadSummary>("library_download_thumbs", { ids });
}

/** Sync page: cache every creation still missing a local preview. */
export async function cacheMissingThumbs(): Promise<DownloadSummary> {
  await ensureAccessToken();
  return invoke<DownloadSummary>("library_cache_missing_thumbs");
}

/** Sync page: cache every creation still missing full local media. */
export async function cacheMissingMedia(): Promise<DownloadSummary> {
  // Unpublished full media requires a live bearer — refresh before Rust runs.
  await ensureAccessToken();
  return invoke<DownloadSummary>("library_cache_missing_media");
}

/** Delete a creation from the local catalog and its media/preview files (not cloud). */
export async function deleteLocal(id: string): Promise<SyncStatus> {
  return invoke<SyncStatus>("library_delete_local", { id });
}

/** Delete after the native all-project usage/membership check. */
export async function deleteCreationChecked(
  id: string,
  auditedProjectIds: readonly string[],
): Promise<SyncStatus> {
  return invoke<SyncStatus>("library_delete_creation_checked", {
    creationId: id,
    auditedProjectIds: [...auditedProjectIds],
  });
}

export type ImportLocalResult = {
  imported: number;
  cancelled: boolean;
  creations: Creation[];
  status: SyncStatus;
};

/** Native file picker → copy into Library/media as local-only creations. */
export async function importFromDisk(): Promise<ImportLocalResult> {
  return invoke<ImportLocalResult>("library_import_from_disk");
}

/** Copy explicit filesystem paths into Library/media as local-only creations. */
export async function importLocalPaths(
  paths: string[],
  folderId?: string | null,
): Promise<ImportLocalResult> {
  return invoke<ImportLocalResult>("library_import_local_paths", {
    paths,
    folderId: folderId?.trim() || null,
  });
}

/** Backend-routed project asset write; the frontend never supplies a folder. */
export async function importProjectAssetPaths(
  projectId: string,
  paths: string[],
): Promise<ImportLocalResult> {
  return invoke<ImportLocalResult>("library_import_project_asset_paths", {
    projectId,
    paths,
  });
}

export async function listProjectAssetIds(projectId: string): Promise<string[]> {
  return invoke<string[]>("library_list_project_asset_ids", { projectId });
}

export async function removeProjectAssets(
  projectId: string,
  creationIds: string[],
): Promise<void> {
  return invoke("library_remove_project_assets", { projectId, creationIds });
}

/** Persist an internal composition run without adding it to the Library. */
export async function cacheCompositionRun(
  sourcePath: string,
  compositionId: string,
): Promise<string> {
  return invoke<string>("library_cache_composition_run", {
    sourcePath,
    compositionId,
  });
}

/** Delete a composition-owned cache file; refuses paths outside that cache. */
export async function deleteCompositionRun(path: string): Promise<void> {
  return invoke("library_delete_composition_run", { path });
}

/** Regenerate local board preview from full local media (native aspect JPEG). */
export async function fillThumb(id: string): Promise<Creation> {
  return invoke<Creation>("library_fill_thumb", { id });
}

/**
 * Cached FFmpeg-reversed copy of local media (+ first-frame thumb for video).
 * Generates files on first call; subsequent calls reuse the cache.
 */
export type ReversedMedia = {
  path: string;
  thumbPath: string | null;
};

export async function ensureReversed(id: string): Promise<ReversedMedia> {
  return invoke<ReversedMedia>("library_ensure_reversed", { id });
}

/** Cached frame at the first displayed source time for a trimmed clip. */
export async function ensureClipThumb(
  id: string,
  reverse: boolean,
  timeSec: number,
  composition?: {
    framing: "fit" | "fill" | "stretch";
    aspectRatio: string;
    zoom: number;
    centerX: number;
    centerY: number;
  },
): Promise<string> {
  return invoke<string>("library_ensure_clip_thumb", {
    id,
    reverse,
    timeSec,
    framing: composition?.framing,
    aspectRatio: composition?.aspectRatio,
    zoom: composition?.zoom,
    centerX: composition?.centerX,
    centerY: composition?.centerY,
  });
}

/** Force-delete and regenerate reversed media for the given asset ids. */
export async function rebuildReversed(ids: string[]): Promise<number> {
  return invoke<number>("library_rebuild_reversed", { ids });
}

export type MergeTimelineClipInput = {
  assetId: string;
  inSec?: number;
  outSec?: number;
  reverse?: boolean;
};

export type MergeProgress = {
  phase: string;
  done: number;
  total: number;
};

export type MergeFinished = {
  ok: boolean;
  creationId: string | null;
  error: string | null;
};

export async function mergeTimelineClips(
  clips: MergeTimelineClipInput[],
): Promise<Creation> {
  return invoke<Creation>("library_merge_timeline_clips", { clips });
}

export type JoinClipInput = {
  assetId: string;
  inSec: number;
  outSec: number;
  reverse?: boolean;
};

export type JoinStrategyInput = {
  strategy: string;
  nudgeAOutFrames?: number;
  nudgeBInFrames?: number;
  holdSide?: string;
  holdFrames?: number;
  removeGap?: boolean;
  fillFrom?: string;
  fillFrames?: number;
  xfadeFrames?: number;
};

export type JoinPreviewRequest = {
  clipA: JoinClipInput;
  clipB: JoinClipInput;
  strategy: JoinStrategyInput;
  previewHalfWindowSec?: number;
};

export type JoinBakeRequest = {
  clipA: JoinClipInput;
  clipB: JoinClipInput;
  strategy: JoinStrategyInput;
};

export type JoinPreviewResult = {
  path: string;
  durationSec: number;
};

export type JoinProgress = {
  phase: string;
  done: number;
  total: number;
};

export async function joinTimelinePreview(
  req: JoinPreviewRequest,
): Promise<JoinPreviewResult> {
  return invoke<JoinPreviewResult>("library_join_preview", { req });
}

export async function joinTimelineBake(
  req: JoinBakeRequest,
): Promise<Creation> {
  return invoke<Creation>("library_join_bake", { req });
}

/** Read local board preview bytes as base64 (for cloud fit upload). */
export async function readLocalThumbBase64(id: string): Promise<string> {
  return invoke<string>("library_read_local_thumb_base64", { id });
}

/**
 * Fill local board thumb from media, then push that JPEG to Parascene as `?variant=fit`.
 * Cloud push failures are thrown so callers can show them; local fill still succeeded.
 */
export async function fillThumbAndPushToCloud(
  id: string,
  opts?: { onWait?: (ms: number) => void },
): Promise<Creation> {
  const creation = await fillThumb(id);
  const { createAuthedSdk, ensureAccessToken } = await import("../auth/session");
  await ensureAccessToken();
  const b64 = await readLocalThumbBase64(id);
  const sdk = createAuthedSdk();
  await sdk.uploadFitThumbnail(id, b64, { onWait: opts?.onWait });
  return creation;
}

/** Drop local previews so the next download can pick up fit thumbs. */
export async function invalidateThumbs(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return invoke<number>("library_invalidate_thumbs", { ids });
}

/** Clear square CDN previews stuck on non-square creations. Returns cleared ids. */
export async function invalidateMismatchedThumbs(): Promise<string[]> {
  return invoke<string[]>("library_invalidate_mismatched_thumbs");
}

/** Local-first fit heal plan from on-disk media + catalog aspect. */
export type LocalFitTarget = {
  id: string;
  title: string;
};

export type LocalFitPlan = {
  regenerate: LocalFitTarget[];
  uploadOnly: LocalFitTarget[];
  cloudRepair: LocalFitTarget[];
};

export async function localFitPlan(): Promise<LocalFitPlan> {
  return invoke<LocalFitPlan>("library_local_fit_plan");
}

/** Upload an existing local board preview as `?variant=fit` (no regenerate). */
export async function pushLocalFitToCloud(
  id: string,
  opts?: { onWait?: (ms: number) => void },
): Promise<void> {
  const { createAuthedSdk, ensureAccessToken } = await import("../auth/session");
  await ensureAccessToken();
  const b64 = await readLocalThumbBase64(id);
  const sdk = createAuthedSdk();
  await sdk.uploadFitThumbnail(id, b64, { onWait: opts?.onWait });
}
