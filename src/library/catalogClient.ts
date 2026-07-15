/**
 * Thin invoke wrappers over the local catalog (SQLite) and download workers.
 *
 * UI paints local disk paths only. Missing assets: `ensureLocal` → Rust saves
 * to disk → `library-creation-updated` → paint. Never load remote media URLs.
 */
import { invoke } from "@tauri-apps/api/core";
import { ensureAccessToken } from "../auth/session";
import type {
  Creation,
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

export async function getCreation(id: string): Promise<Creation> {
  return invoke<Creation>("library_get_creation", { id });
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("library_sync_status");
}

export async function applyManifest(
  creations: CreationUpsert[],
): Promise<SyncStatus> {
  return invoke<SyncStatus>("library_apply_manifest", { creations });
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

/** Regenerate local board preview from full local media (native aspect JPEG). */
export async function fillThumb(id: string): Promise<Creation> {
  return invoke<Creation>("library_fill_thumb", { id });
}
