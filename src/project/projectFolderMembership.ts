import type { LibraryFolder } from "../library/folderClient";
import {
  replaceStoredProjectAssets,
  type StoredProject,
} from "./projectStore";

/**
 * Native `library_mark_project_usage_stale` fail-closed message. Not a user
 * action — the app must remirror `creationIds` from the folder, then save.
 */
export const MEMBERSHIP_MIRROR_STALE_MESSAGE =
  "Project membership changed and must be mirrored before editing the project";

export function isMembershipMirrorStaleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("must be mirrored before editing the project");
}

/** One-way copy of native project-folder `memberIds` onto each project's JSON. */
export function mirrorProjectFolderMembership(
  projects: StoredProject[],
  folders: readonly LibraryFolder[],
): StoredProject[] {
  const projectFolders = new Map(
    folders
      .filter((folder) => folder.kind === "project" && folder.projectId)
      .map((folder) => [folder.projectId as string, folder]),
  );
  return projects.map((project) => {
    const folder = projectFolders.get(project.id);
    return folder
      ? replaceStoredProjectAssets(project, folder.memberIds)
      : project;
  });
}
