import { getCreations } from "../library/catalogClient";
import {
  getProjectFolder,
  removeProjectAssetsChecked,
} from "./projectFolderClient";
import {
  collectCabinetMemberIdsFromCovers,
  type ProjectOwnershipFields,
} from "./projectOwnership";

export type CollapseCabinetFolderResult = {
  removedIds: string[];
  memberIds: string[];
  messages: string[];
};

/**
 * Unfile cabinet members that were flattened into the project folder.
 * Covers stay; timeline refs to members remain valid via ownership helper.
 */
export async function collapseCabinetMembersFromProjectFolder(opts: {
  projectId: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  onProgress?: (note: string) => void;
}): Promise<CollapseCabinetFolderResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const messages: string[] = [];
  const folder = await getProjectFolder(opts.projectId);
  const memberIds = folder.memberIds.map(String);
  const ownership: ProjectOwnershipFields = {
    creationIds: memberIds,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
  };
  const coverIds = [opts.imagesGroupId, opts.videosGroupId].flatMap((raw) => {
    const id = raw?.trim() ?? "";
    return id && memberIds.includes(id) ? [id] : [];
  });

  if (coverIds.length === 0) {
    messages.push("No Images/Videos covers in the project folder to collapse.");
    return { removedIds: [], memberIds, messages };
  }

  onProgress(`Loading ${coverIds.length} cabinet cover(s)…`);
  const covers = await getCreations(coverIds);
  const cabinetMembers = collectCabinetMemberIdsFromCovers(ownership, covers);
  const candidates = memberIds.filter(
    (id) => cabinetMembers.has(id) && !coverIds.includes(id),
  );

  if (candidates.length === 0) {
    messages.push("Project folder already cover-only for cabinet members.");
    return { removedIds: [], memberIds, messages };
  }

  onProgress(
    `Unfiling ${candidates.length} cabinet member(s) from the project folder…`,
  );
  const result = await removeProjectAssetsChecked(opts.projectId, candidates);
  const nextMembers = result.folder.memberIds.map(String);
  messages.push(
    `Removed ${candidates.length} cabinet member(s) from the folder; covers remain.`,
  );
  return {
    removedIds: candidates,
    memberIds: nextMembers,
    messages,
  };
}
