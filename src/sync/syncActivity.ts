export type SyncItemKind = "thumb" | "media";
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

/** Keep at most this many finished rows; in-flight rows are never trimmed. */
export const MAX_FINISHED_SYNC_ACTIVITY = 250;

export function syncActivityKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function normalizeSyncKind(kind: string): SyncItemKind {
  return kind === "media" ? "media" : "thumb";
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

function isFinished(state: SyncItemState): boolean {
  return state === "done" || state === "failed" || state === "skipped";
}

/** Drop oldest finished rows first; never drop queued/active. */
export function trimSyncActivity(items: SyncActivityItem[]): SyncActivityItem[] {
  let finished = 0;
  for (const item of items) {
    if (isFinished(item.state)) finished += 1;
  }
  if (finished <= MAX_FINISHED_SYNC_ACTIVITY) return items;

  let drop = finished - MAX_FINISHED_SYNC_ACTIVITY;
  return items.filter((item) => {
    if (!isFinished(item.state)) return true;
    if (drop > 0) {
      drop -= 1;
      return false;
    }
    return true;
  });
}

/**
 * Append new items at the bottom; update existing rows in place (no re-ordering).
 * Top → bottom is queue order: older first, newer last.
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
      // Keep prior detail if the new event didn't include one.
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

export function syncItemStateLabel(state: SyncItemState): string {
  if (state === "active") return "Downloading";
  if (state === "done") return "Done";
  if (state === "failed") return "Failed";
  if (state === "skipped") return "Skipped";
  return "Queued";
}

export function syncItemKindLabel(kind: SyncItemKind): string {
  return kind === "media" ? "Media" : "Preview";
}
