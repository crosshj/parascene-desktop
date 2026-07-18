import { invoke } from "@tauri-apps/api/core";
import type { LibraryFolderOperation } from "../sdk/parascene";

export type LibraryFolder = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  memberIds: string[];
  memberCount: number;
};

export type CloudFolderRow = {
  id: string;
  title: string;
  description: string;
  createdAt: string | null;
  updatedAt: string | null;
  creationIds: string[];
  memberCount: number;
};

export type PendingFolderOp = {
  seq: number;
  op: LibraryFolderOperation;
  createdAt: string;
};

export type FolderSyncState = {
  revision: number | null;
  pendingOps: PendingFolderOp[];
  folders: LibraryFolder[];
  baselineFolders: CloudFolderRow[];
};

export async function listFolders(): Promise<LibraryFolder[]> {
  return invoke<LibraryFolder[]>("library_list_folders");
}

export async function listFiledCreationIds(): Promise<string[]> {
  return invoke<string[]>("library_list_filed_creation_ids");
}

export async function getFolder(id: string): Promise<LibraryFolder> {
  return invoke<LibraryFolder>("library_get_folder", { id });
}

export async function createFolder(
  title: string,
  creationIds: string[],
): Promise<LibraryFolder> {
  return invoke<LibraryFolder>("library_create_folder", {
    title,
    creationIds,
  });
}

export async function renameFolder(
  id: string,
  title: string,
  description: string,
): Promise<LibraryFolder> {
  return invoke<LibraryFolder>("library_rename_folder", {
    id,
    title,
    description,
  });
}

export async function addToFolder(
  folderId: string,
  creationIds: string[],
): Promise<LibraryFolder> {
  return invoke<LibraryFolder>("library_add_to_folder", {
    folderId,
    creationIds,
  });
}

export async function removeFromFolder(creationIds: string[]): Promise<void> {
  return invoke("library_remove_from_folder", { creationIds });
}

export async function deleteFolder(id: string): Promise<void> {
  return invoke("library_delete_folder", { id });
}

export async function getFolderSyncState(): Promise<FolderSyncState> {
  return invoke<FolderSyncState>("library_folder_sync_state");
}

export async function applyFolderSnapshot(
  revision: number,
  folders: CloudFolderRow[],
): Promise<FolderSyncState> {
  return invoke<FolderSyncState>("library_folders_apply_snapshot", {
    revision,
    folders,
  });
}

export async function ackFolderOps(seqs: number[]): Promise<FolderSyncState> {
  return invoke<FolderSyncState>("library_folders_ack_ops", { seqs });
}

export async function setFolderPendingOps(
  ops: LibraryFolderOperation[],
): Promise<FolderSyncState> {
  return invoke<FolderSyncState>("library_folders_set_pending_ops", { ops });
}

/** Creations currently filed into any folder should be hidden from Library home. */
export function omitFiledCreations<T extends { id: string }>(
  creations: readonly T[],
  filedIds: ReadonlySet<string>,
): T[] {
  if (filedIds.size === 0) return [...creations];
  return creations.filter((c) => !filedIds.has(c.id));
}

export function filedIdSet(ids: readonly string[]): Set<string> {
  return new Set(ids);
}

export function remoteFoldersToCloudRows(
  folders: Array<{
    id: string;
    title: string;
    description: string;
    created_at: string | null;
    updated_at: string | null;
    creation_ids: number[];
    member_count: number;
  }>,
): CloudFolderRow[] {
  return folders.map((folder) => ({
    id: folder.id,
    title: folder.title,
    description: folder.description,
    createdAt: folder.created_at,
    updatedAt: folder.updated_at,
    creationIds: folder.creation_ids.map(String),
    memberCount: folder.member_count,
  }));
}
