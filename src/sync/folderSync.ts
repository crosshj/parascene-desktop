import { ensureAccessToken } from "../auth/session";
import {
  mutateLibraryFoldersSnapshot,
  pullLibraryFoldersSnapshot,
} from "../services/folderSyncApi";
import {
  ackFolderOps,
  applyFolderSnapshot,
  desktopFolderMeta,
  getFolderSyncState,
  projectIdFromFolderMeta as projectIdFromClientFolderMeta,
  remoteFoldersToCloudRows,
  setFolderPendingOps,
  type CloudFolderRow,
  type FolderSyncState,
  type PendingFolderOp,
} from "../library/folderClient";
import {
  LibraryFoldersConflictError,
  LibraryFoldersUnavailableError,
  type LibraryFolderOperation,
  type LibraryFoldersSnapshot,
  type RemoteLibraryFolder,
} from "../sdk/parascene";
import {
  buildFolderSyncFailureTrace,
  logFolderSyncFailure,
  withPendingOpsContext,
} from "./folderSyncDiagnostics";

export const LIBRARY_FOLDER_OPS_MAX = 100;
export const LIBRARY_FOLDER_CREATION_IDS_MAX = 500;

function projectMeta(
  projectId: string,
  coverCreationId?: string | null,
): Record<string, unknown> {
  return desktopFolderMeta({ projectId, coverCreationId });
}

function projectIdFromFolderMeta(
  meta: Record<string, unknown> | undefined | null,
): string | null {
  return projectIdFromClientFolderMeta(meta);
}

function metaClearsProjectMarker(meta: unknown): boolean {
  if (meta == null || typeof meta !== "object" || Array.isArray(meta)) {
    return false;
  }
  return projectIdFromFolderMeta(meta as Record<string, unknown>) == null;
}

/** One-release adapter for pending ops written by the pre-metadata desktop build. */
export function normalizePendingOperation(
  operation: LibraryFolderOperation,
): LibraryFolderOperation {
  const raw = operation as unknown as Record<string, unknown>;
  const projectId =
    typeof raw.project_id === "string" && raw.project_id.trim()
      ? raw.project_id.trim()
      : null;
  if (raw.op === "claim_project" && projectId) {
    return {
      op: "update",
      id: String(raw.id),
      title: typeof raw.title === "string" ? raw.title : undefined,
      meta: projectMeta(projectId),
      project_id: projectId,
    };
  }
  if (raw.op === "create" || raw.op === "update") {
    const rest = Object.fromEntries(
      Object.entries(raw).filter(
        ([key]) => key !== "kind" && key !== "project_id",
      ),
    );
    return {
      ...(rest as unknown as LibraryFolderOperation),
      ...(projectId
        ? {
            meta:
              raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
                ? (raw.meta as Record<string, unknown>)
                : projectMeta(projectId),
            project_id: projectId,
          }
        : {}),
    } as LibraryFolderOperation;
  }
  return operation;
}

/**
 * Marker clears must assert ownership (`project_id` matching the cloud marker).
 * Clears that already include `project_id` (delete-project / manual Release) are
 * kept. Stuck empty-meta clears **without** project_id came from auto-liberate of
 * foreign/unavailable project folders — drop them so this client does not try to
 * take over another device's project marker.
 */
export function assertProjectIdOnMarkerClear(
  operation: LibraryFolderOperation,
): LibraryFolderOperation {
  const normalized = normalizePendingOperation(operation);
  if (normalized.op !== "update") return normalized;
  // Only explicit empty meta is a marker clear. Title-only updates omit meta.
  if (normalized.meta === undefined) return normalized;
  if (!metaClearsProjectMarker(normalized.meta)) return normalized;
  const existing =
    typeof normalized.project_id === "string" && normalized.project_id.trim()
      ? normalized.project_id.trim()
      : null;
  if (existing) {
    return { ...normalized, project_id: existing, meta: {} };
  }
  return normalized;
}

/**
 * Empty-meta `update` cannot clear markers on the server ("marker cannot be
 * changed"). Owned clears (have project_id) expand to delete + create regular.
 * Unowned clears (no project_id) are dropped elsewhere.
 */
export function isOwnedMarkerClear(operation: LibraryFolderOperation): boolean {
  const normalized = normalizePendingOperation(operation);
  if (normalized.op !== "update") return false;
  if (normalized.meta === undefined) return false;
  if (!metaClearsProjectMarker(normalized.meta)) return false;
  return (
    typeof normalized.project_id === "string" &&
    Boolean(normalized.project_id.trim())
  );
}

export type FolderReleaseLookup = {
  title: string;
  description: string;
  creationIds: number[];
};

/**
 * Replace owned empty-meta clears with delete+create, and drop redundant
 * title-only updates for those same folder ids.
 */
export function rewriteOwnedMarkerClearsToDeleteCreate(
  pending: PendingFolderOp[],
  lookup: Map<string, FolderReleaseLookup>,
): LibraryFolderOperation[] {
  const releaseIds = new Set<string>();
  const titleOverride = new Map<string, { title?: string; description?: string }>();

  for (const row of pending) {
    const op = normalizePendingOperation(row.op);
    if (isOwnedMarkerClear(op) && op.op === "update") {
      releaseIds.add(op.id);
    }
  }
  for (const row of pending) {
    const op = normalizePendingOperation(row.op);
    if (
      op.op === "update" &&
      op.meta === undefined &&
      releaseIds.has(op.id)
    ) {
      titleOverride.set(op.id, {
        title: typeof op.title === "string" ? op.title : undefined,
        description:
          typeof op.description === "string" ? op.description : undefined,
      });
    }
  }

  const out: LibraryFolderOperation[] = [];
  for (const row of pending) {
    const op = normalizePendingOperation(row.op);
    if (isOwnedMarkerClear(op) && op.op === "update") {
      const info = lookup.get(op.id);
      const override = titleOverride.get(op.id);
      const title =
        (override?.title && override.title.trim()) ||
        (typeof op.title === "string" && op.title.trim() ? op.title.trim() : null) ||
        info?.title ||
        "Untitled folder";
      const description =
        override?.description ??
        (typeof op.description === "string"
          ? op.description
          : (info?.description ?? ""));
      const creationIds = info?.creationIds ?? [];
      const projectId = op.project_id!.trim();
      out.push({ op: "delete", id: op.id, project_id: projectId });
      out.push({
        op: "create",
        id: op.id,
        title,
        description,
        meta: {},
        ...(creationIds.length > 0 ? { creation_ids: creationIds } : {}),
      });
      continue;
    }
    if (
      op.op === "update" &&
      op.meta === undefined &&
      releaseIds.has(op.id)
    ) {
      continue;
    }
    out.push(op);
  }
  return out;
}

export function buildFolderReleaseLookup(
  cloud: RemoteLibraryFolder[],
  local: Array<{
    id: string;
    title: string;
    description: string;
    memberIds?: string[];
  }>,
  baseline: CloudFolderRow[],
): Map<string, FolderReleaseLookup> {
  const out = new Map<string, FolderReleaseLookup>();
  const put = (
    id: string,
    title: string,
    description: string,
    creationIds: Array<string | number>,
  ) => {
    const nums = creationIds
      .map((v) => (typeof v === "number" ? v : Number(v)))
      .filter((n) => Number.isFinite(n) && n > 0);
    const prev = out.get(id);
    out.set(id, {
      title: title.trim() || prev?.title || "Untitled folder",
      description,
      creationIds: nums.length > 0 ? nums : (prev?.creationIds ?? []),
    });
  };
  for (const folder of baseline) {
    put(folder.id, folder.title, folder.description, folder.creationIds ?? []);
  }
  for (const folder of cloud) {
    put(folder.id, folder.title, folder.description, folder.creation_ids ?? []);
  }
  for (const folder of local) {
    put(folder.id, folder.title, folder.description, folder.memberIds ?? []);
  }
  return out;
}

/** True when this op is an empty-meta clear that never asserted ownership. */
export function isUnownedMarkerClear(operation: LibraryFolderOperation): boolean {
  const normalized = normalizePendingOperation(operation);
  if (normalized.op !== "update") return false;
  if (normalized.meta === undefined) return false;
  if (!metaClearsProjectMarker(normalized.meta)) return false;
  const existing =
    typeof normalized.project_id === "string" && normalized.project_id.trim()
      ? normalized.project_id.trim()
      : null;
  return !existing;
}

/** Drop mistaken foreign marker clears; keep ownership-asserted clears. */
export function dropUnownedMarkerClears(
  pending: PendingFolderOp[],
): { kept: PendingFolderOp[]; dropped: PendingFolderOp[] } {
  const kept: PendingFolderOp[] = [];
  const dropped: PendingFolderOp[] = [];
  for (const row of pending) {
    if (isUnownedMarkerClear(row.op)) dropped.push(row);
    else kept.push(row);
  }
  return { kept, dropped };
}

/**
 * Drop pending creates/deletes that the cloud already reflects so Sync does not
 * loop on `folder id already exists` / `folder not found`.
 *
 * - Drop `create` when the folder id is already on cloud, unless a pending
 *   `delete` for that id remains (project release: delete then recreate).
 * - Drop `delete` when the folder id is already absent from cloud.
 */
export function dropRedundantFolderOps(
  pending: PendingFolderOp[],
  cloud: RemoteLibraryFolder[],
): { kept: PendingFolderOp[]; dropped: PendingFolderOp[] } {
  const cloudIds = new Set(
    cloud.map((folder) => folder.id).filter((id) => Boolean(id?.trim())),
  );
  const pendingDeleteIds = new Set<string>();
  for (const row of pending) {
    const op = normalizePendingOperation(row.op);
    if (op.op === "delete" && op.id.trim()) {
      pendingDeleteIds.add(op.id.trim());
    }
  }

  const kept: PendingFolderOp[] = [];
  const dropped: PendingFolderOp[] = [];
  for (const row of pending) {
    const op = normalizePendingOperation(row.op);
    if (op.op === "create") {
      const id = op.id.trim();
      if (id && cloudIds.has(id) && !pendingDeleteIds.has(id)) {
        dropped.push(row);
        continue;
      }
    } else if (op.op === "delete") {
      const id = op.id.trim();
      if (id && !cloudIds.has(id)) {
        dropped.push(row);
        continue;
      }
    }
    kept.push(row);
  }
  return { kept, dropped };
}

/** Normalize owned marker-clear updates (preserve project_id on empty meta). */
export function rewritePendingMarkerClears(
  pending: PendingFolderOp[],
): PendingFolderOp[] {
  return pending.map((row) => ({
    ...row,
    op: assertProjectIdOnMarkerClear(row.op),
  }));
}

export type FolderConflictKind =
  | "folder_meta"
  | "creation_move"
  | "delete_vs_edit";

export type FolderConflict = {
  id: string;
  kind: FolderConflictKind;
  summary: string;
  /** Folder id and/or creation id involved. */
  folderId?: string;
  creationId?: string;
  localLabel: string;
  cloudLabel: string;
};

export type FolderSyncResult = {
  ok: boolean;
  unavailable?: boolean;
  revision: number | null;
  pendingCount: number;
  uploadedBatches: number;
  conflicts: FolderConflict[];
  message?: string;
};

type FolderMaps = {
  byId: Map<string, RemoteLibraryFolder | CloudFolderRow>;
  membership: Map<string, string>; // creationId -> folderId
};

function asRemote(folder: RemoteLibraryFolder | CloudFolderRow): {
  id: string;
  title: string;
  description: string;
  creationIds: string[];
  meta: Record<string, unknown>;
} {
  if ("creation_ids" in folder) {
    return {
      id: folder.id,
      title: folder.title,
      description: folder.description,
      creationIds: folder.creation_ids.map(String),
      meta: folder.meta ?? {},
    };
  }
  return {
    id: folder.id,
    title: folder.title,
    description: folder.description,
    creationIds: folder.creationIds.map(String),
    meta: folder.meta ?? {},
  };
}

function mapsFromFolders(
  folders: Array<RemoteLibraryFolder | CloudFolderRow>,
): FolderMaps {
  const byId = new Map<string, RemoteLibraryFolder | CloudFolderRow>();
  const membership = new Map<string, string>();
  for (const folder of folders) {
    const row = asRemote(folder);
    byId.set(row.id, folder);
    for (const creationId of row.creationIds) {
      membership.set(creationId, row.id);
    }
  }
  return { byId, membership };
}

function chunkOps(
  ops: LibraryFolderOperation[],
  max = LIBRARY_FOLDER_OPS_MAX,
): LibraryFolderOperation[][] {
  if (ops.length === 0) return [];
  const chunks: LibraryFolderOperation[][] = [];
  for (let i = 0; i < ops.length; i += max) {
    chunks.push(ops.slice(i, i + max));
  }
  return chunks;
}

function splitLargeMoveOps(
  ops: LibraryFolderOperation[],
): LibraryFolderOperation[] {
  const out: LibraryFolderOperation[] = [];
  for (const op of ops) {
    if (op.op !== "move") {
      out.push(op);
      continue;
    }
    const ids = op.creation_ids ?? [];
    if (ids.length <= LIBRARY_FOLDER_CREATION_IDS_MAX) {
      out.push(op);
      continue;
    }
    for (let i = 0; i < ids.length; i += LIBRARY_FOLDER_CREATION_IDS_MAX) {
      out.push({
        op: "move",
        folder_id: op.folder_id,
        creation_ids: ids.slice(i, i + LIBRARY_FOLDER_CREATION_IDS_MAX),
        ...(op.project_id ? { project_id: op.project_id } : {}),
      });
    }
  }
  return out;
}

function splitLargeCreateOps(
  ops: LibraryFolderOperation[],
): LibraryFolderOperation[] {
  const out: LibraryFolderOperation[] = [];
  for (const op of ops) {
    if (op.op !== "create") {
      out.push(op);
      continue;
    }
    const ids = op.creation_ids ?? [];
    if (ids.length <= LIBRARY_FOLDER_CREATION_IDS_MAX) {
      out.push(op);
      continue;
    }
    out.push({
      ...op,
      creation_ids: ids.slice(0, LIBRARY_FOLDER_CREATION_IDS_MAX),
    });
    const rest = ids.slice(LIBRARY_FOLDER_CREATION_IDS_MAX);
    for (let i = 0; i < rest.length; i += LIBRARY_FOLDER_CREATION_IDS_MAX) {
      out.push({
        op: "move",
        folder_id: op.id,
        creation_ids: rest.slice(i, i + LIBRARY_FOLDER_CREATION_IDS_MAX),
        ...(op.project_id ? { project_id: op.project_id } : {}),
      });
    }
  }
  return out;
}

/** Normalize pending ops for API upload (limits + ordering preserved). */
export function prepareOpsForUpload(
  pending: PendingFolderOp[],
): { ops: LibraryFolderOperation[]; seqs: number[] } {
  // When we split, all chunks share the originating seq for ack purposes.
  const seqs: number[] = [];
  const expanded: LibraryFolderOperation[] = [];
  for (const row of pending) {
    const prepared = splitLargeMoveOps(
      splitLargeCreateOps([assertProjectIdOnMarkerClear(row.op)]),
    );
    for (const op of prepared) {
      expanded.push(op);
      seqs.push(row.seq);
    }
  }
  return { ops: expanded, seqs };
}

function folderLabel(folder: { title: string; id: string }): string {
  return folder.title.trim() || folder.id;
}

/**
 * Detect conflicts between local pending ops and a newer cloud snapshot,
 * using the last-known baseline for three-way comparison.
 */
export function detectFolderConflicts(
  baseline: CloudFolderRow[],
  cloud: RemoteLibraryFolder[],
  pending: PendingFolderOp[],
): FolderConflict[] {
  if (pending.length === 0) return [];

  const base = mapsFromFolders(baseline);
  const remote = mapsFromFolders(cloud);
  const conflicts: FolderConflict[] = [];
  const seen = new Set<string>();

  const push = (conflict: FolderConflict) => {
    if (seen.has(conflict.id)) return;
    seen.add(conflict.id);
    conflicts.push(conflict);
  };

  for (const row of pending) {
    const op = row.op;
    if (op.op === "create") {
      // Create for an id already on cloud is healed by dropRedundantFolderOps
      // (unless paired with a pending delete for release). Title drift stays on
      // pending updates — do not surface a folder_meta conflict here.
      continue;
    }

    if (op.op === "update") {
      const baseFolder = base.byId.get(op.id);
      const cloudFolder = remote.byId.get(op.id);
      if (!cloudFolder) {
        // Never in baseline ⇒ never known on cloud (e.g. local create still
        // pending). A sibling pending create for the same id means upload has
        // not landed yet — not a remote delete.
        const pendingCreate = pending.some(
          (row) => row.op.op === "create" && row.op.id === op.id,
        );
        if (!baseFolder || pendingCreate) {
          continue;
        }
        push({
          id: `delete_vs_edit:${op.id}`,
          kind: "delete_vs_edit",
          summary: `Folder “${op.title ?? op.id}” was deleted in the cloud but edited here`,
          folderId: op.id,
          localLabel: op.title?.trim() || op.id,
          cloudLabel: "Deleted in cloud",
        });
        continue;
      }
      if (!baseFolder) continue;
      const baseRow = asRemote(baseFolder);
      const cloudRow = asRemote(cloudFolder);
      const cloudChanged =
        cloudRow.title !== baseRow.title ||
        cloudRow.description !== baseRow.description ||
        JSON.stringify(cloudRow.meta) !== JSON.stringify(baseRow.meta);
      const localTitle = op.title ?? baseRow.title;
      const localDescription = op.description ?? baseRow.description;
      const localMeta = op.meta ?? baseRow.meta;
      const localChanged =
        localTitle !== baseRow.title ||
        localDescription !== baseRow.description ||
        JSON.stringify(localMeta) !== JSON.stringify(baseRow.meta);
      if (cloudChanged && localChanged) {
        const same =
          localTitle === cloudRow.title &&
          localDescription === cloudRow.description &&
          JSON.stringify(localMeta) === JSON.stringify(cloudRow.meta);
        if (!same) {
          push({
            id: `folder_meta:${op.id}`,
            kind: "folder_meta",
            summary: `Folder “${folderLabel({ title: localTitle, id: op.id })}” was edited on both sides`,
            folderId: op.id,
            localLabel: localTitle,
            cloudLabel: cloudRow.title,
          });
        }
      }
      continue;
    }

    if (op.op === "delete") {
      const baseFolder = base.byId.get(op.id);
      const cloudFolder = remote.byId.get(op.id);
      if (!baseFolder || !cloudFolder) continue;
      const baseRow = asRemote(baseFolder);
      const cloudRow = asRemote(cloudFolder);
      const cloudEdited =
        cloudRow.title !== baseRow.title ||
        cloudRow.description !== baseRow.description ||
        cloudRow.creationIds.join(",") !== baseRow.creationIds.join(",");
      if (cloudEdited) {
        push({
          id: `delete_vs_edit:${op.id}`,
          kind: "delete_vs_edit",
          summary: `Folder “${folderLabel(cloudRow)}” was edited in the cloud but deleted here`,
          folderId: op.id,
          localLabel: "Deleted on this desktop",
          cloudLabel: folderLabel(cloudRow),
        });
      }
      continue;
    }

    if (op.op === "move") {
      for (const creationId of op.creation_ids.map(String)) {
        const baseFolderId = base.membership.get(creationId) ?? null;
        const cloudFolderId = remote.membership.get(creationId) ?? null;
        const localFolderId = op.folder_id;
        if (cloudFolderId === baseFolderId) continue; // cloud unchanged for this creation
        if (cloudFolderId === localFolderId) continue; // already matches local intent
        // Cloud moved differently than local pending move.
        push({
          id: `creation_move:${creationId}`,
          kind: "creation_move",
          summary: `Creation ${creationId} was filed differently on both sides`,
          creationId,
          folderId: localFolderId ?? undefined,
          localLabel: localFolderId
            ? `Folder ${localFolderId}`
            : "Unfiled on this desktop",
          cloudLabel: cloudFolderId
            ? `Folder ${cloudFolderId}`
            : "Unfiled in cloud",
        });
      }
    }
  }

  return conflicts;
}

/**
 * Drop pending ops that lose to cloud for the given conflict resolutions.
 * `resolution` map: conflict.id -> "local" | "cloud"
 */
export function applyConflictResolutions(
  pending: PendingFolderOp[],
  conflicts: FolderConflict[],
  resolutions: Record<string, "local" | "cloud">,
): LibraryFolderOperation[] {
  const dropFolderIds = new Set<string>();
  const dropCreationIds = new Set<string>();

  for (const conflict of conflicts) {
    if (resolutions[conflict.id] !== "cloud") continue;
    if (conflict.folderId) dropFolderIds.add(conflict.folderId);
    if (conflict.creationId) dropCreationIds.add(conflict.creationId);
  }

  const kept: LibraryFolderOperation[] = [];
  for (const row of pending) {
    const op = row.op;
    if (
      op.op === "create" ||
      op.op === "update" ||
      op.op === "delete"
    ) {
      if (dropFolderIds.has(op.id)) continue;
      kept.push(op);
      continue;
    }
    if (op.op === "move") {
      const remaining = op.creation_ids.filter(
        (id) => !dropCreationIds.has(String(id)),
      );
      if (remaining.length === 0) continue;
      if (op.folder_id && dropFolderIds.has(op.folder_id)) continue;
      kept.push({ ...op, creation_ids: remaining });
    }
  }
  return kept;
}

async function pullSnapshot(): Promise<LibraryFoldersSnapshot> {
  await ensureAccessToken();
  return pullLibraryFoldersSnapshot();
}

async function pushOps(
  baseRevision: number,
  ops: LibraryFolderOperation[],
): Promise<LibraryFoldersSnapshot> {
  await ensureAccessToken();
  return mutateLibraryFoldersSnapshot({ baseRevision, operations: ops });
}

function resultFromState(
  state: FolderSyncState,
  partial: Partial<FolderSyncResult>,
): FolderSyncResult {
  return {
    ok: partial.ok ?? true,
    unavailable: partial.unavailable,
    revision: state.revision,
    pendingCount: state.pendingOps.length,
    uploadedBatches: partial.uploadedBatches ?? 0,
    conflicts: partial.conflicts ?? [],
    message: partial.message,
  };
}

/**
 * Sync Library folders with Parascene.
 * Safe concurrent changes merge automatically; true conflicts are returned for UI.
 */
export async function syncLibraryFolders(opts?: {
  /** Pre-applied resolutions for known conflicts (retry path). */
  resolutions?: Record<string, "local" | "cloud">;
  /** Existing conflicts from a prior pass (with resolutions). */
  priorConflicts?: FolderConflict[];
  /**
   * After snapshot adopt / before upload. Optional; do not use for auto-liberating
   * foreign/unavailable project folders.
   */
  beforeUpload?: () => Promise<void>;
}): Promise<FolderSyncResult> {
  let state = await getFolderSyncState();
  let uploadedBatches = 0;

  if (opts?.resolutions && opts.priorConflicts?.length) {
    const resolved = applyConflictResolutions(
      state.pendingOps,
      opts.priorConflicts,
      opts.resolutions,
    );
    state = await setFolderPendingOps(resolved);
  }

  let cloud: LibraryFoldersSnapshot;
  try {
    cloud = await pullSnapshot();
  } catch (e) {
    if (e instanceof LibraryFoldersUnavailableError) {
      const message = withPendingOpsContext(e.message, state.pendingOps);
      logFolderSyncFailure(
        buildFolderSyncFailureTrace({
          phase: "pull",
          message,
          revision: state.revision,
          pending: state.pendingOps,
        }),
      );
      return resultFromState(state, {
        ok: false,
        unavailable: true,
        message,
      });
    }
    const message = e instanceof Error ? e.message : String(e);
    if (/unauthorized|session expired|not signed in/i.test(message)) {
      throw new Error(
        "Your Parascene session expired. Reconnect in the browser, then retry Sync.",
      );
    }
    logFolderSyncFailure(
      buildFolderSyncFailureTrace({
        phase: "pull",
        message,
        revision: state.revision,
        pending: state.pendingOps,
      }),
    );
    throw e;
  }

  // No local pending: install cloud snapshot as truth.
  if (state.pendingOps.length === 0) {
    state = await applyFolderSnapshot(
      cloud.revision,
      remoteFoldersToCloudRows(cloud.folders),
    );
  } else {
    const localRevision = state.revision;
    const cloudAhead =
      localRevision == null || cloud.revision !== localRevision;

    if (cloudAhead) {
      const conflicts = detectFolderConflicts(
        state.baselineFolders,
        cloud.folders,
        state.pendingOps,
      );
      if (conflicts.length > 0) {
        // Install cloud baseline snapshot into meta without dropping pending ops:
        // apply snapshot replaces folders; keep pending for retry after resolution.
        state = await applyFolderSnapshot(
          cloud.revision,
          remoteFoldersToCloudRows(cloud.folders),
        );
        // Re-read pending (apply_snapshot does not clear pending).
        state = await getFolderSyncState();
        return resultFromState(state, {
          ok: false,
          conflicts,
          message:
            "Folder changes conflict with the cloud. Resolve them to continue.",
        });
      }

      // Safe: adopt cloud folders as the new baseline/local view, keep pending.
      state = await applyFolderSnapshot(
        cloud.revision,
        remoteFoldersToCloudRows(cloud.folders),
      );
      state = await getFolderSyncState();
    }
  }

  // Optional hook after snapshot (kept for callers that need to enqueue owned
  // ops before upload). Do not auto-liberate foreign project folders here.
  if (opts?.beforeUpload) {
    await opts.beforeUpload();
    state = await getFolderSyncState();
  }

  // Drop mistaken foreign marker clears (empty meta, no project_id). Those came
  // from auto-liberating unavailable project folders — this client must not take
  // over another device's marker. Re-apply cloud so locked project folders return.
  const { kept, dropped } = dropUnownedMarkerClears(state.pendingOps);
  if (dropped.length > 0) {
    logFolderSyncFailure(
      buildFolderSyncFailureTrace({
        phase: "drop-unowned-clears",
        message: `Dropped ${dropped.length} unowned project-marker clear(s); restoring cloud project folders as browse-only on this device.`,
        revision: state.revision,
        pending: dropped,
      }),
    );
    state = await setFolderPendingOps(kept.map((row) => row.op));
    state = await applyFolderSnapshot(
      cloud.revision,
      remoteFoldersToCloudRows(cloud.folders),
    );
    state = await getFolderSyncState();
  }

  // Owned empty-meta clears are rejected by the API ("marker cannot be changed").
  // Expand them to ownership-asserted delete + create regular (same id/members).
  if (state.pendingOps.some((row) => isOwnedMarkerClear(row.op))) {
    const lookup = buildFolderReleaseLookup(
      cloud.folders,
      state.folders,
      state.baselineFolders,
    );
    const expanded = rewriteOwnedMarkerClearsToDeleteCreate(
      state.pendingOps,
      lookup,
    );
    logFolderSyncFailure(
      buildFolderSyncFailureTrace({
        phase: "expand-marker-release",
        message: `Rewrote owned marker clear(s) to delete+create (${expanded.length} op(s)).`,
        revision: state.revision,
        pending: state.pendingOps,
      }),
    );
    state = await setFolderPendingOps(expanded);
  }

  if (state.pendingOps.length === 0) {
    return resultFromState(state, { ok: true, uploadedBatches: 0 });
  }

  const rewritten = rewritePendingMarkerClears(state.pendingOps);
  const rewriteChanged = rewritten.some((row, i) => {
    const prev = state.pendingOps[i]!;
    return JSON.stringify(prev.op) !== JSON.stringify(row.op);
  });
  if (rewriteChanged) {
    state = await setFolderPendingOps(rewritten.map((row) => row.op));
  }

  // Upload pending ops in batches.
  let guard = 0;
  while (state.pendingOps.length > 0 && guard < 20) {
    guard += 1;

    // Drop creates for ids already on cloud (unless paired with delete for release)
    // and deletes for ids already gone — prevents stuck `folder id already exists`.
    {
      const { kept, dropped } = dropRedundantFolderOps(
        state.pendingOps,
        cloud.folders,
      );
      if (dropped.length > 0) {
        logFolderSyncFailure(
          buildFolderSyncFailureTrace({
            phase: "drop-redundant-ops",
            message: `Dropped ${dropped.length} redundant folder op(s) already reflected on cloud.`,
            revision: state.revision,
            pending: dropped,
          }),
        );
        state = await setFolderPendingOps(kept.map((row) => row.op));
      }
    }
    if (state.pendingOps.length === 0) break;

    const { ops, seqs } = prepareOpsForUpload(state.pendingOps);
    const batches = chunkOps(ops);
    if (batches.length === 0) break;

    const batch = batches[0]!;
    const batchSeqs = seqs.slice(0, batch.length);
    const baseRevision = state.revision ?? 0;

    try {
      const next = await pushOps(baseRevision, batch);
      cloud = next;
      state = await applyFolderSnapshot(
        next.revision,
        remoteFoldersToCloudRows(next.folders),
      );
      state = await ackFolderOps([...new Set(batchSeqs)]);
      uploadedBatches += 1;
    } catch (e) {
      if (e instanceof LibraryFoldersConflictError) {
        cloud = { revision: e.revision, folders: e.folders };
        state = await applyFolderSnapshot(
          e.revision,
          remoteFoldersToCloudRows(e.folders),
        );
        state = await getFolderSyncState();
        const conflicts = detectFolderConflicts(
          state.baselineFolders,
          e.folders,
          state.pendingOps,
        );
        if (conflicts.length > 0) {
          return resultFromState(state, {
            ok: false,
            uploadedBatches,
            conflicts,
            message:
              "Folder changes conflict with the cloud. Resolve them to continue.",
          });
        }
        // Safe concurrent change — retry loop with updated revision.
        continue;
      }
      if (e instanceof LibraryFoldersUnavailableError) {
        const message = withPendingOpsContext(e.message, state.pendingOps);
        logFolderSyncFailure(
          buildFolderSyncFailureTrace({
            phase: "mutate",
            message,
            revision: state.revision,
            pending: state.pendingOps,
            uploadBatch: batch,
          }),
        );
        return resultFromState(state, {
          ok: false,
          unavailable: true,
          uploadedBatches,
          message,
        });
      }
      // On 400 / other errors: re-pull, then heal redundant create/delete if the
      // API reported ids that already exist or are already gone.
      const rawMessage = e instanceof Error ? e.message : String(e);
      try {
        const fresh = await pullSnapshot();
        cloud = fresh;
        state = await applyFolderSnapshot(
          fresh.revision,
          remoteFoldersToCloudRows(fresh.folders),
        );
        state = await getFolderSyncState();
      } catch {
        /* keep prior state */
      }
      if (/folder id already exists|folder not found/i.test(rawMessage)) {
        const { kept, dropped } = dropRedundantFolderOps(
          state.pendingOps,
          cloud.folders,
        );
        if (dropped.length > 0) {
          logFolderSyncFailure(
            buildFolderSyncFailureTrace({
              phase: "drop-redundant-ops",
              message: `After mutate error (${rawMessage}): dropped ${dropped.length} redundant folder op(s); retrying upload.`,
              revision: state.revision,
              pending: dropped,
              uploadBatch: batch,
            }),
          );
          state = await setFolderPendingOps(kept.map((row) => row.op));
          continue;
        }
      }
      const message = withPendingOpsContext(rawMessage, state.pendingOps);
      logFolderSyncFailure(
        buildFolderSyncFailureTrace({
          phase: "mutate",
          message,
          revision: state.revision,
          pending: state.pendingOps,
          uploadBatch: batch,
        }),
      );
      return resultFromState(state, {
        ok: false,
        uploadedBatches,
        message,
      });
    }
  }

  state = await getFolderSyncState();
  if (state.pendingOps.length > 0) {
    const message = withPendingOpsContext(
      "Some folder changes are still pending",
      state.pendingOps,
    );
    logFolderSyncFailure(
      buildFolderSyncFailureTrace({
        phase: "incomplete",
        message,
        revision: state.revision,
        pending: state.pendingOps,
      }),
    );
    return resultFromState(state, {
      ok: false,
      uploadedBatches,
      message,
    });
  }
  return resultFromState(state, {
    ok: true,
    uploadedBatches,
  });
}

export function folderConflictKindLabel(kind: FolderConflictKind): string {
  if (kind === "folder_meta") return "Folder details";
  if (kind === "creation_move") return "Filing";
  return "Delete vs edit";
}
