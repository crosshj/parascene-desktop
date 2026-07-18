import { createAuthedSdk, ensureAccessToken } from "../auth/session";
import {
  ackFolderOps,
  applyFolderSnapshot,
  getFolderSyncState,
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

export const LIBRARY_FOLDER_OPS_MAX = 100;
export const LIBRARY_FOLDER_CREATION_IDS_MAX = 500;

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
} {
  if ("creation_ids" in folder) {
    return {
      id: folder.id,
      title: folder.title,
      description: folder.description,
      creationIds: folder.creation_ids.map(String),
    };
  }
  return {
    id: folder.id,
    title: folder.title,
    description: folder.description,
    creationIds: folder.creationIds.map(String),
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
    const prepared = splitLargeMoveOps(splitLargeCreateOps([row.op]));
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
      const cloudFolder = remote.byId.get(op.id);
      if (cloudFolder) {
        // Distinct create ids are safe; same id already on cloud is unusual — treat as meta conflict.
        const local = asRemote({
          id: op.id,
          title: op.title ?? "Untitled folder",
          description: op.description ?? "",
          creation_ids: op.creation_ids ?? [],
          member_count: (op.creation_ids ?? []).length,
          created_at: null,
          updated_at: null,
        });
        const cloudRow = asRemote(cloudFolder);
        if (
          local.title !== cloudRow.title ||
          local.description !== cloudRow.description
        ) {
          push({
            id: `folder_meta:${op.id}`,
            kind: "folder_meta",
            summary: `Folder “${folderLabel(local)}” was changed on both sides`,
            folderId: op.id,
            localLabel: folderLabel(local),
            cloudLabel: folderLabel(cloudRow),
          });
        }
      }
      continue;
    }

    if (op.op === "update") {
      const baseFolder = base.byId.get(op.id);
      const cloudFolder = remote.byId.get(op.id);
      if (!cloudFolder) {
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
        cloudRow.description !== baseRow.description;
      const localTitle = op.title ?? baseRow.title;
      const localDescription = op.description ?? baseRow.description;
      const localChanged =
        localTitle !== baseRow.title || localDescription !== baseRow.description;
      if (cloudChanged && localChanged) {
        const same =
          localTitle === cloudRow.title &&
          localDescription === cloudRow.description;
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
    if (op.op === "create" || op.op === "update" || op.op === "delete") {
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
  const sdk = createAuthedSdk();
  return sdk.getLibraryFolders();
}

async function pushOps(
  baseRevision: number,
  ops: LibraryFolderOperation[],
): Promise<LibraryFoldersSnapshot> {
  await ensureAccessToken();
  const sdk = createAuthedSdk();
  return sdk.mutateLibraryFolders({ baseRevision, operations: ops });
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
      return resultFromState(state, {
        ok: false,
        unavailable: true,
        message: e.message,
      });
    }
    throw e;
  }

  // No local pending: install cloud snapshot as truth.
  if (state.pendingOps.length === 0) {
    state = await applyFolderSnapshot(
      cloud.revision,
      remoteFoldersToCloudRows(cloud.folders),
    );
    return resultFromState(state, { ok: true, uploadedBatches: 0 });
  }

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
        message: "Folder changes conflict with the cloud. Resolve them to continue.",
      });
    }

    // Safe: adopt cloud folders as the new baseline/local view, keep pending.
    state = await applyFolderSnapshot(
      cloud.revision,
      remoteFoldersToCloudRows(cloud.folders),
    );
    state = await getFolderSyncState();
  }

  // Upload pending ops in batches.
  let guard = 0;
  while (state.pendingOps.length > 0 && guard < 20) {
    guard += 1;
    const { ops, seqs } = prepareOpsForUpload(state.pendingOps);
    const batches = chunkOps(ops);
    if (batches.length === 0) break;

    const batch = batches[0]!;
    const batchSeqs = seqs.slice(0, batch.length);
    const baseRevision = state.revision ?? 0;

    try {
      const next = await pushOps(baseRevision, batch);
      state = await applyFolderSnapshot(
        next.revision,
        remoteFoldersToCloudRows(next.folders),
      );
      state = await ackFolderOps([...new Set(batchSeqs)]);
      uploadedBatches += 1;
    } catch (e) {
      if (e instanceof LibraryFoldersConflictError) {
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
        return resultFromState(state, {
          ok: false,
          unavailable: true,
          uploadedBatches,
          message: e.message,
        });
      }
      // On 400 / other errors: re-pull then surface.
      try {
        const fresh = await pullSnapshot();
        state = await applyFolderSnapshot(
          fresh.revision,
          remoteFoldersToCloudRows(fresh.folders),
        );
        state = await getFolderSyncState();
      } catch {
        /* keep prior state */
      }
      const message = e instanceof Error ? e.message : String(e);
      return resultFromState(state, {
        ok: false,
        uploadedBatches,
        message,
      });
    }
  }

  state = await getFolderSyncState();
  return resultFromState(state, {
    ok: state.pendingOps.length === 0,
    uploadedBatches,
    message:
      state.pendingOps.length === 0
        ? undefined
        : "Some folder changes are still pending",
  });
}

export function folderConflictKindLabel(kind: FolderConflictKind): string {
  if (kind === "folder_meta") return "Folder details";
  if (kind === "creation_move") return "Filing";
  return "Delete vs edit";
}
