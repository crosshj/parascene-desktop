export const OPEN_LIBRARY_FOLDER_EVENT = "parascene-open-library-folder";
export const PREVIEW_WIPE_PROJECT_EVENT = "parascene-preview-wipe-project";

let pendingFolderId: string | null | undefined;

export function requestOpenLibraryFolder(folderId: string | null): void {
  pendingFolderId = folderId;
  window.dispatchEvent(
    new CustomEvent(OPEN_LIBRARY_FOLDER_EVENT, { detail: { folderId } }),
  );
}

export function takePendingLibraryFolderId(): string | null | undefined {
  const next = pendingFolderId;
  pendingFolderId = undefined;
  return next;
}

export function requestPreviewWipeProject(opts: {
  id: string;
  title: string;
}): void {
  window.dispatchEvent(
    new CustomEvent(PREVIEW_WIPE_PROJECT_EVENT, { detail: opts }),
  );
}
