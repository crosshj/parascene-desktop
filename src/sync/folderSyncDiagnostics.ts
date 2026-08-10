import { invoke } from "@tauri-apps/api/core";
import type { PendingFolderOp } from "../library/folderClient";
import type { LibraryFolderOperation } from "../sdk/parascene";

const LOG_PREFIX = "[folder-sync]";

/** Compact one-line view of a pending/upload op for Sync UI + console. */
export type FolderOpTrace = {
  seq?: number;
  op: string;
  id?: string;
  title?: string;
  projectId?: string | null;
  /** True when update/create sends empty meta (clears project marker). */
  clearsProjectMeta?: boolean;
  creationCount?: number;
};

function projectIdFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const desktop = (meta as Record<string, unknown>).parascene_desktop;
  if (!desktop || typeof desktop !== "object" || Array.isArray(desktop)) {
    return null;
  }
  const id = (desktop as Record<string, unknown>).project_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function metaIsEmpty(meta: unknown): boolean {
  if (meta == null) return false;
  if (typeof meta !== "object" || Array.isArray(meta)) return false;
  return Object.keys(meta as Record<string, unknown>).length === 0;
}

export function summarizeFolderOperation(
  op: LibraryFolderOperation,
  seq?: number,
): FolderOpTrace {
  const raw = op as LibraryFolderOperation & {
    id?: string;
    title?: string;
    project_id?: string;
    folder_id?: string;
    creation_ids?: Array<string | number>;
    meta?: Record<string, unknown>;
  };
  const id =
    typeof raw.id === "string"
      ? raw.id
      : typeof raw.folder_id === "string"
        ? raw.folder_id
        : undefined;
  const title = typeof raw.title === "string" ? raw.title : undefined;
  const projectId =
    typeof raw.project_id === "string" && raw.project_id.trim()
      ? raw.project_id.trim()
      : projectIdFromMeta(raw.meta);
  const creationCount = Array.isArray(raw.creation_ids)
    ? raw.creation_ids.length
    : undefined;
  const clearsProjectMeta =
    (raw.op === "update" || raw.op === "create") && metaIsEmpty(raw.meta);

  return {
    ...(seq != null ? { seq } : {}),
    op: raw.op,
    ...(id ? { id } : {}),
    ...(title ? { title } : {}),
    ...(projectId ? { projectId } : {}),
    ...(clearsProjectMeta ? { clearsProjectMeta: true } : {}),
    ...(creationCount != null ? { creationCount } : {}),
  };
}

export function summarizePendingFolderOps(
  pending: PendingFolderOp[],
): FolderOpTrace[] {
  return pending.map((row) => summarizeFolderOperation(row.op, row.seq));
}

/** Short Sync-banner appendix, e.g. `7 pending: update×7 (meta clear)`. */
export function formatPendingOpsHeadline(pending: PendingFolderOp[]): string {
  if (pending.length === 0) return "0 pending";
  const counts = new Map<string, number>();
  let metaClears = 0;
  for (const row of pending) {
    const trace = summarizeFolderOperation(row.op, row.seq);
    counts.set(trace.op, (counts.get(trace.op) ?? 0) + 1);
    if (trace.clearsProjectMeta) metaClears += 1;
  }
  const parts = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([op, n]) => `${op}×${n}`);
  const clearNote = metaClears > 0 ? ` (meta clear×${metaClears})` : "";
  return `${pending.length} pending: ${parts.join(", ")}${clearNote}`;
}

export type FolderSyncFailureTrace = {
  at: string;
  phase: string;
  message: string;
  revision: number | null;
  pendingCount: number;
  pendingHeadline: string;
  pending: FolderOpTrace[];
  uploadBatch?: FolderOpTrace[];
  hint?: string;
};

const KNOWN_HINTS: Array<{ test: RegExp; hint: string }> = [
  {
    test: /project folder marker cannot be changed/i,
    hint:
      "Folder API forbids clearing meta.parascene_desktop.project_id via update. Release/delete must ownership-assert delete then create the same folder as regular. Sync rewrites stuck empty-meta clears to that pair. See docs/STANDARDS-sync-diagnostics.md.",
  },
  {
    test: /project folder is locked on this client/i,
    hint:
      "User-edit lock on a project-marked folder (no local project document), or a mutate without ownership assertion. Unowned empty-meta clears are dropped on Sync — this client must not take over foreign project markers. Owned clears need delete+create, not empty-meta update. See docs/STANDARDS-sync-diagnostics.md.",
  },
  {
    test: /folder id already exists/i,
    hint:
      "Pending create targets a folder id already on cloud (often after a partial upload). Sync drops that create unless a pending delete for the same id remains (project release). Retry Sync folders. See docs/STANDARDS-sync-diagnostics.md.",
  },
  {
    test: /folder not found/i,
    hint:
      "Pending delete or mutate targets a folder already gone from cloud. Sync drops orphan deletes; remaining ops retry. See docs/STANDARDS-sync-diagnostics.md.",
  },
  {
    test: /base_revision is stale|conflict/i,
    hint:
      "Cloud revision moved; resolve folder conflicts in Sync or retry after pull.",
  },
];

export function hintForFolderSyncMessage(message: string): string | undefined {
  for (const row of KNOWN_HINTS) {
    if (row.test.test(message)) return row.hint;
  }
  return undefined;
}

export function buildFolderSyncFailureTrace(opts: {
  phase: string;
  message: string;
  revision: number | null;
  pending: PendingFolderOp[];
  uploadBatch?: LibraryFolderOperation[];
}): FolderSyncFailureTrace {
  return {
    at: new Date().toISOString(),
    phase: opts.phase,
    message: opts.message,
    revision: opts.revision,
    pendingCount: opts.pending.length,
    pendingHeadline: formatPendingOpsHeadline(opts.pending),
    pending: summarizePendingFolderOps(opts.pending),
    ...(opts.uploadBatch
      ? {
          uploadBatch: opts.uploadBatch.map((op) =>
            summarizeFolderOperation(op),
          ),
        }
      : {}),
    ...((): { hint?: string } => {
      const hint = hintForFolderSyncMessage(opts.message);
      return hint ? { hint } : {};
    })(),
  };
}

/** Append pending headline to the UI error string (keeps first line readable). */
export function withPendingOpsContext(
  message: string,
  pending: PendingFolderOp[],
): string {
  if (pending.length === 0) return message;
  const headline = formatPendingOpsHeadline(pending);
  if (message.includes(headline)) return message;
  return `${message} · ${headline}`;
}

/**
 * Always log a structured failure so agents/devs can triage without hunting SQLite first.
 * Writes `Library/logs/folder-sync.jsonl` and mirrors to console with `[folder-sync]`.
 */
export function logFolderSyncFailure(trace: FolderSyncFailureTrace): void {
  console.error(`${LOG_PREFIX} ${trace.phase} failed`, trace);
  void invoke<string>("library_append_diag_log", {
    channel: "folder-sync",
    payload: trace,
  }).catch((error) => {
    console.warn(`${LOG_PREFIX} could not write disk trace`, error);
  });
}
