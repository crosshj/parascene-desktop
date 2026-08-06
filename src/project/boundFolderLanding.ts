/**
 * Land newly imported local creations into the project's bound working folder.
 */

import { importProjectAssetPaths, type ImportLocalResult } from "../library/catalogClient";
import { addToFolder, getFolder } from "../library/folderClient";

async function assertFolderMembership(
  folderId: string,
  creationIds: readonly string[],
): Promise<void> {
  const folder = await getFolder(folderId);
  const members = new Set(folder.memberIds);
  const missing = creationIds.filter((id) => !members.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Project asset write did not land in working folder ${folderId}: ${missing.join(", ")}`,
    );
  }
}

/**
 * Import local paths into the Library, then (when bound) file them into the
 * project's working folder. Membership is one-folder-per-creation; this moves
 * creations into the bound folder if they were elsewhere.
 */
export async function importLocalPathsForProject(opts: {
  paths: string[];
  projectId: string;
}): Promise<ImportLocalResult> {
  return importProjectAssetPaths(opts.projectId, opts.paths);
}

/** File existing creation ids into the bound folder (no-op when unbound). */
export async function landCreationsInBoundFolder(opts: {
  creationIds: readonly string[];
  boundFolderId: string | null | undefined;
}): Promise<void> {
  const folderId = opts.boundFolderId?.trim() || "";
  if (!folderId || opts.creationIds.length === 0) return;
  const creationIds = opts.creationIds
    .map((id) => String(id).trim())
    .filter(Boolean);
  if (creationIds.length === 0) return;
  await addToFolder(folderId, creationIds);
  await assertFolderMembership(folderId, creationIds);
}
