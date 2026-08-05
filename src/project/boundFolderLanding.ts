/**
 * Land newly imported local creations into the project's bound working folder.
 */

import {
  importLocalPaths,
  type ImportLocalResult,
} from "../library/catalogClient";
import { addToFolder } from "../library/folderClient";

/**
 * Import local paths into the Library, then (when bound) file them into the
 * project's working folder. Membership is one-folder-per-creation; this moves
 * creations into the bound folder if they were elsewhere.
 */
export async function importLocalPathsForProject(opts: {
  paths: string[];
  boundFolderId: string | null | undefined;
}): Promise<ImportLocalResult> {
  const imported = await importLocalPaths(opts.paths);
  const folderId = opts.boundFolderId?.trim() || "";
  if (!folderId || imported.creations.length === 0) {
    return imported;
  }
  const creationIds = imported.creations
    .map((c) => c.id?.trim())
    .filter((id): id is string => Boolean(id));
  if (creationIds.length === 0) return imported;
  try {
    await addToFolder(folderId, creationIds);
  } catch (error) {
    console.error(
      "[importLocalPathsForProject] Failed to file into bound folder",
      folderId,
      error,
    );
    // Import succeeded; landing is best-effort so callers still get creations.
  }
  return imported;
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
}
