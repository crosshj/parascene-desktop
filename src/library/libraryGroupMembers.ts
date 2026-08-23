import { createAuthedSdk } from "../auth/session";
import { ingestRemoteCreation } from "../lab/ingestCreation";
import {
  idsForGroupApiCall,
  memberIdsFromRemoteGroup,
} from "../lab/projectGroups";
import { collapseCabinetMembersFromProjectFolder } from "../project/cabinetFolderCollapse";
import {
  identifyDesktopCabinet,
  projectGroupKindForRole,
} from "../project/desktopProjectGroups";
import { addProjectAssets } from "../project/projectFolderClient";
import { loadStoredProjectStrict } from "../project/projectStore";
import {
  downloadIds,
  downloadThumbs,
} from "./catalogClient";
import type { Creation } from "./types";

/** Append creations into an existing Parascene group cover (Library or project). */
export async function appendMembersToGroupCover(opts: {
  groupId: string;
  memberIds: string[];
  onProgress?: (note: string) => void;
}): Promise<{ groupId: string; addedMemberIds: string[] }> {
  const groupId = opts.groupId.trim();
  const memberIds = [
    ...new Set(opts.memberIds.map((id) => id.trim()).filter(Boolean)),
  ].filter((id) => id !== groupId);
  if (!groupId || memberIds.length === 0) {
    throw new Error("Choose at least one asset to add to the group.");
  }
  const onProgress = opts.onProgress ?? (() => {});
  const sdk = createAuthedSdk();
  onProgress(`Adding ${memberIds.length} file(s) to the group…`);
  const ids = idsForGroupApiCall(groupId, memberIds);
  const grouped = await sdk.groupCreations({ ids });
  const nextGroupId = String(grouped.id);

  const fresh = await sdk.getCreation(nextGroupId);
  const liveMembers = memberIdsFromRemoteGroup(fresh);
  await ingestRemoteCreation(fresh);
  await downloadIds([nextGroupId]);
  await downloadThumbs([nextGroupId]);

  const missing = memberIds.filter((id) => !liveMembers.includes(id));
  if (liveMembers.length > 0 && missing.length > 0) {
    throw new Error(
      `Grouped as ${nextGroupId} but Parascene still missing member(s): ${missing.join(", ")}`,
    );
  }

  return { groupId: nextGroupId, addedMemberIds: memberIds };
}

/** Desktop project cabinets: keep folder tiles collapsed after Library filing. */
export async function followUpDesktopCabinetGroupAppend(opts: {
  groupId: string;
  cover: Creation | null | undefined;
  onProgress?: (note: string) => void;
}): Promise<void> {
  const cabinet = identifyDesktopCabinet(opts.cover);
  const projectId = cabinet?.projectId?.trim();
  if (!cabinet || !projectId) return;

  const onProgress = opts.onProgress ?? (() => {});
  let stored;
  try {
    stored = loadStoredProjectStrict(projectId);
  } catch {
    return;
  }

  const kind = projectGroupKindForRole(cabinet.role);
  await addProjectAssets(projectId, [opts.groupId]);
  onProgress("Updating project folder…");
  await collapseCabinetMembersFromProjectFolder({
    projectId,
    imagesGroupId: kind === "images" ? opts.groupId : (stored.imagesGroupId ?? null),
    videosGroupId: kind === "videos" ? opts.groupId : (stored.videosGroupId ?? null),
    onProgress,
  });
}
