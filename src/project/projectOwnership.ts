import { groupSourceCreationIds } from "../library/creationFlags";
import type { StoredProject } from "./projectStore";

export type ProjectOwnershipFields = Pick<
  StoredProject,
  "creationIds" | "imagesGroupId" | "videosGroupId"
>;

/**
 * True when `creationId` is owned by the project for save / Assets purposes:
 * either a folder member (`creationIds`), or a member of an Images/Videos
 * cabinet whose cover is itself a folder member.
 */
export function isProjectOwnedCreation(
  project: ProjectOwnershipFields,
  creationId: string,
  cabinetMemberIds?: ReadonlySet<string>,
): boolean {
  const id = creationId.trim();
  if (!id) return false;
  if (project.creationIds.includes(id)) return true;
  if (cabinetMemberIds?.has(id)) return true;
  return false;
}

/** Cover ids for Images/Videos that are currently filed in the project folder. */
export function projectCabinetCoverIdsInFolder(
  project: ProjectOwnershipFields,
): string[] {
  const members = new Set(project.creationIds);
  const out: string[] = [];
  for (const coverId of [project.imagesGroupId, project.videosGroupId]) {
    const id = coverId?.trim() ?? "";
    if (id && members.has(id)) out.push(id);
  }
  return out;
}

/**
 * Member ids of project cabinet covers that are filed in the folder.
 * Cover ids themselves are excluded.
 */
export function collectCabinetMemberIdsFromCovers(
  project: ProjectOwnershipFields,
  covers: ReadonlyArray<{
    id: string;
    remoteJson?: string | null;
  }>,
): Set<string> {
  const coverIds = new Set(projectCabinetCoverIdsInFolder(project));
  const out = new Set<string>();
  for (const cover of covers) {
    if (!coverIds.has(cover.id)) continue;
    for (const memberId of groupSourceCreationIds(cover)) {
      if (memberId && memberId !== cover.id) out.add(memberId);
    }
  }
  return out;
}
