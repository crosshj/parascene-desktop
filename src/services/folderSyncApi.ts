/**
 * Library folder cloud API via service_invoke (sync Result handles).
 */
import {
  LibraryFoldersConflictError,
  LibraryFoldersUnavailableError,
  parseLibraryFoldersSnapshot,
  type LibraryFolderOperation,
  type LibraryFoldersSnapshot,
} from "../sdk/parascene";
import { serviceInvoke } from "./serviceClient";

function foldersUnavailable(message: string): never {
  throw new LibraryFoldersUnavailableError(message);
}

function parseFolderServiceError(message: string): never {
  if (message.startsWith("FOLDERS_UNAVAILABLE:")) {
    foldersUnavailable(message.slice("FOLDERS_UNAVAILABLE:".length).trim());
  }
  throw new Error(message);
}

function asFolderSnapshot(data: unknown): LibraryFoldersSnapshot {
  return parseLibraryFoldersSnapshot(data);
}

export async function pullLibraryFoldersSnapshot(): Promise<LibraryFoldersSnapshot> {
  try {
    const handle = await serviceInvoke({
      service: "sync",
      operation: "folder_pull",
      payload: {},
    });
    if (handle.mode !== "result") {
      throw new Error("sync.folder_pull expected a sync result handle");
    }
    return asFolderSnapshot(handle.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parseFolderServiceError(message);
  }
}

export async function mutateLibraryFoldersSnapshot(opts: {
  baseRevision: number;
  operations: LibraryFolderOperation[];
}): Promise<LibraryFoldersSnapshot> {
  try {
    const handle = await serviceInvoke({
      service: "sync",
      operation: "folder_mutate",
      payload: {
        baseRevision: opts.baseRevision,
        operations: opts.operations,
      },
    });
    if (handle.mode !== "result") {
      throw new Error("sync.folder_mutate expected a sync result handle");
    }
    const data = handle.data;
    if (data && typeof data === "object") {
      const row = data as Record<string, unknown>;
      if (row.__conflict === true) {
        throw new LibraryFoldersConflictError(
          parseLibraryFoldersSnapshot(row.snapshot),
        );
      }
    }
    return asFolderSnapshot(data);
  } catch (err) {
    if (err instanceof LibraryFoldersConflictError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    parseFolderServiceError(message);
  }
}
