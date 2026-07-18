import type { SyncStatus } from "../library/types";

export function formatLastSync(lastSyncAt: string | null): string {
  if (!lastSyncAt) return "Never";
  const d = new Date(lastSyncAt);
  if (Number.isNaN(d.getTime())) return lastSyncAt;
  return d.toLocaleString();
}

export function syncCountsSummary(status: SyncStatus): string {
  return [
    `${status.local} local`,
    `${status.remote} remote`,
    `${status.queued} queued`,
    `${status.downloading} downloading`,
    `${status.failed} failed`,
  ].join(" · ");
}

export function phaseLabel(phase: string | undefined): string {
  if (phase === "thumbs") return "Caching previews";
  if (phase === "media") return "Caching media";
  if (phase === "catalog") return "Updating catalog";
  return "Working";
}

/** Friendly disk size, e.g. `4.7 GB` / `383 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : n >= 10 ? 0 : 1;
  return `${n.toFixed(digits)} ${units[i]}`;
}

export function syncDiskSummary(status: SyncStatus): string {
  return `${formatBytes(status.mediaBytes)} media · ${formatBytes(status.thumbsBytes)} previews`;
}

/** Cloud-backed creations with no local thumb and no downloadable preview URL (e.g. WIP). */
export function unsyncableThumbCount(status: SyncStatus): number {
  return Math.max(0, status.missingThumbUncacheable);
}

/** Cloud-backed creations with no local media and no remote URL. */
export function unsyncableMediaCount(status: SyncStatus): number {
  return Math.max(0, status.missingMediaUncacheable);
}

/** Prefer filename, then title, then id — for Sync “can't cache” list. */
export function withoutCloudUrlLabel(item: {
  id: string;
  title: string;
  filename: string | null;
}): string {
  const name = item.filename?.trim() || item.title?.trim();
  return name || item.id;
}

/** Web creation detail page on Parascene, e.g. `…/creations/123`. */
export function creationPageUrl(baseUrl: string, creationId: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/creations/${encodeURIComponent(creationId)}`;
}
