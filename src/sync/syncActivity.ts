export type SyncItemKind = "thumb" | "media" | "repair" | "catalog" | "folders";
export type SyncItemState =
  | "queued"
  | "active"
  | "done"
  | "failed"
  | "skipped";

export type SyncItemEvent = {
  id: string;
  title: string;
  kind: SyncItemKind | string;
  state: SyncItemState | string;
  detail?: string | null;
};

export type SyncActivityItem = {
  key: string;
  id: string;
  title: string;
  kind: SyncItemKind;
  state: SyncItemState;
  detail: string | null;
  updatedAt: number;
};

/** High-level jobs kept in Recent (newest last). */
export const MAX_JOB_HISTORY = 12;
/** In-flight preview/media rows shown while downloading. */
export const MAX_LIVE_DOWNLOADS = 12;
/** Recent download failures kept for diagnosis. */
export const MAX_FAILED_DOWNLOADS = 8;

/** @deprecated Use MAX_JOB_HISTORY — finished thumb spam is no longer retained. */
export const MAX_FINISHED_SYNC_ACTIVITY = MAX_JOB_HISTORY;

export function syncActivityKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function normalizeSyncKind(kind: string): SyncItemKind {
  if (kind === "media") return "media";
  if (kind === "repair") return "repair";
  if (kind === "catalog") return "catalog";
  if (kind === "folders") return "folders";
  return "thumb";
}

export function normalizeSyncState(state: string): SyncItemState {
  if (
    state === "active" ||
    state === "done" ||
    state === "failed" ||
    state === "skipped"
  ) {
    return state;
  }
  return "queued";
}

export function isSyncJobKind(kind: SyncItemKind): boolean {
  return kind === "catalog" || kind === "folders" || kind === "repair";
}

export function isSyncDownloadKind(kind: SyncItemKind): boolean {
  return kind === "thumb" || kind === "media";
}

function isFinished(state: SyncItemState): boolean {
  return state === "done" || state === "failed" || state === "skipped";
}

function isLive(state: SyncItemState): boolean {
  return state === "queued" || state === "active";
}

export function partitionSyncActivity(items: SyncActivityItem[]): {
  jobs: SyncActivityItem[];
  downloads: SyncActivityItem[];
} {
  const jobs: SyncActivityItem[] = [];
  const downloads: SyncActivityItem[] = [];
  for (const item of items) {
    if (isSyncJobKind(item.kind)) jobs.push(item);
    else downloads.push(item);
  }
  return { jobs, downloads };
}

/**
 * Keep recent high-level jobs; only live (and a few failed) downloads.
 * Successful preview/media rows disappear — no 250-item dump.
 */
export function trimSyncActivity(items: SyncActivityItem[]): SyncActivityItem[] {
  const { jobs, downloads } = partitionSyncActivity(items);

  const liveJobs = jobs.filter((j) => isLive(j.state));
  const finishedJobs = jobs.filter((j) => isFinished(j.state));
  const keptFinishedJobs =
    finishedJobs.length <= MAX_JOB_HISTORY
      ? finishedJobs
      : finishedJobs.slice(finishedJobs.length - MAX_JOB_HISTORY);

  const liveDownloads = downloads.filter((d) => isLive(d.state));
  const failedDownloads = downloads.filter((d) => d.state === "failed");
  // Successful done/skipped downloads are dropped.
  const keptLive =
    liveDownloads.length <= MAX_LIVE_DOWNLOADS
      ? liveDownloads
      : [
          ...liveDownloads.filter((d) => d.state === "active"),
          ...liveDownloads.filter((d) => d.state === "queued"),
        ].slice(0, MAX_LIVE_DOWNLOADS);
  const keptFailed =
    failedDownloads.length <= MAX_FAILED_DOWNLOADS
      ? failedDownloads
      : failedDownloads.slice(failedDownloads.length - MAX_FAILED_DOWNLOADS);

  return [...liveJobs, ...keptFinishedJobs, ...keptLive, ...keptFailed];
}

/**
 * Append / update rows. Download successes are removed; jobs stay in a short history.
 */
export function applySyncItemEvent(
  items: SyncActivityItem[],
  event: SyncItemEvent,
  now = Date.now(),
): SyncActivityItem[] {
  const kind = normalizeSyncKind(event.kind);
  const state = normalizeSyncState(event.state);
  const key = syncActivityKey(kind, event.id);
  const detail =
    typeof event.detail === "string" && event.detail.trim()
      ? event.detail.trim()
      : null;

  // Preview/media finished successfully → drop the row (batch progress covers it).
  if (
    isSyncDownloadKind(kind) &&
    (state === "done" || state === "skipped")
  ) {
    return trimSyncActivity(items.filter((item) => item.key !== key));
  }

  const next: SyncActivityItem = {
    key,
    id: event.id,
    title: event.title || event.id,
    kind,
    state,
    detail,
    updatedAt: now,
  };
  const idx = items.findIndex((item) => item.key === key);
  if (idx >= 0) {
    const out = items.slice();
    out[idx] = {
      ...next,
      detail: next.detail ?? items[idx].detail,
    };
    return trimSyncActivity(out);
  }
  return trimSyncActivity([...items, next]);
}

export function clearFinishedSyncActivity(
  items: SyncActivityItem[],
): SyncActivityItem[] {
  return items.filter((item) => !isFinished(item.state));
}

export function countFinishedSyncActivity(items: SyncActivityItem[]): number {
  return items.filter((item) => isFinished(item.state)).length;
}

export function syncItemStateLabel(
  state: SyncItemState,
  kind?: SyncItemKind,
): string {
  if (state === "active") {
    if (kind === "repair") return "Repairing";
    if (kind === "catalog") return "Syncing";
    if (kind === "folders") return "Syncing";
    return "Downloading";
  }
  if (state === "done") return "Done";
  if (state === "failed") return "Failed";
  if (state === "skipped") return "Skipped";
  return "Queued";
}

export function syncItemKindLabel(kind: SyncItemKind): string {
  if (kind === "media") return "Media";
  if (kind === "repair") return "Repair";
  if (kind === "catalog") return "Catalog";
  if (kind === "folders") return "Folders";
  return "Preview";
}
