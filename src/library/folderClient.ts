import { invoke } from "@tauri-apps/api/core";

export type LibraryFolder = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  memberIds: string[];
  memberCount: number;
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
