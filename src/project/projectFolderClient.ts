import { invoke } from "@tauri-apps/api/core";
import type { LibraryFolder } from "../library/folderClient";
import type { ProjectAssetUsage } from "./projectUsage";

export type ProjectFolderBlockerGroup = {
  folderId: string | null;
  folderTitle: string;
  projectId: string | null;
  creationIds: string[];
};

export type ProjectFolderReconcileResult = {
  status: "ready" | "blocked";
  folder: LibraryFolder | null;
  resolution: "marked" | "bound" | "empty" | "all-root" | "single-folder" | null;
  blockers: ProjectFolderBlockerGroup[];
  missingCreationIds: string[];
  bindingProblem: string | null;
  membershipRevision: number | null;
};

export type ProjectAssetMutationResult = {
  folder: LibraryFolder;
  membershipRevision: number;
  missingCreationIds: string[];
};

export type ProjectAssetUsageBlocker = ProjectAssetUsage & {
  projectId: string;
};

export function reconcileLegacyProjectFolder(opts: {
  projectId: string;
  title: string;
  boundFolderIds: string[];
  legacyAssetIds: string[];
}): Promise<ProjectFolderReconcileResult> {
  return invoke("library_reconcile_legacy_project_folder", opts);
}

export function getProjectFolder(projectId: string): Promise<LibraryFolder> {
  return invoke("library_get_project_folder", { projectId });
}

export function provisionProjectFolder(
  projectId: string,
  title: string,
  creationIds: string[],
): Promise<ProjectAssetMutationResult> {
  return invoke("library_provision_project_folder", {
    projectId,
    title,
    creationIds,
  });
}

export function renameProjectFolder(
  projectId: string,
  title: string,
): Promise<LibraryFolder> {
  return invoke("library_rename_project", { projectId, title });
}

export function addProjectAssets(
  projectId: string,
  creationIds: string[],
  allowCrossProjectMove = false,
): Promise<ProjectAssetMutationResult> {
  return invoke("library_add_project_assets", {
    projectId,
    creationIds,
    allowCrossProjectMove,
  });
}

export function removeProjectAssetsChecked(
  projectId: string,
  creationIds: string[],
): Promise<ProjectAssetMutationResult> {
  return invoke("library_remove_project_assets", { projectId, creationIds });
}

export type DeleteProjectResult = {
  projectId: string;
  folderId: string | null;
  releasedMemberIds: string[];
};

/** Release the project folder (media kept) and clear native usage indexes. */
export function deleteProjectNative(projectId: string): Promise<DeleteProjectResult> {
  return invoke("library_delete_project", { projectId });
}

export function markProjectUsageStale(
  projectId: string,
  expectedDocumentRevision: string | null,
  nextDocumentRevision: string,
  allowExistingStale = false,
): Promise<void> {
  return invoke("library_mark_project_usage_stale", {
    projectId,
    expectedDocumentRevision,
    nextDocumentRevision,
    allowExistingStale,
  });
}

export function replaceProjectUsage(
  projectId: string,
  documentRevision: string,
  usageRows: ProjectAssetUsage[],
): Promise<void> {
  return invoke("library_replace_project_usage", {
    projectId,
    documentRevision,
    usageRows,
  });
}

export function repairProjectUsage(
  projectId: string,
  documentRevision: string,
  usageRows: ProjectAssetUsage[],
): Promise<void> {
  return invoke("library_repair_project_usage", {
    projectId,
    documentRevision,
    usageRows,
  });
}

export function checkCreationUsage(
  creationIds: string[],
): Promise<ProjectAssetUsageBlocker[]> {
  return invoke("library_check_creation_usage", { creationIds });
}
