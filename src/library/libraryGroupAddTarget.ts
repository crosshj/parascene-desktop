import {
  groupSourceCreationIds,
  isGroupCreation,
} from "./creationFlags";
import type { Creation } from "./types";

export type LibraryGroupAddTarget = {
  groupId: string;
  groupLabel: string;
  memberMediaKind: "image" | "video";
  memberIds: string[];
};

function mediaKind(
  creation: Creation | undefined,
): "image" | "video" | "audio" | null {
  const mt = String(creation?.mediaType ?? "").trim().toLowerCase();
  if (mt === "image" || mt === "video" || mt === "audio") return mt;
  return null;
}

function groupMemberMediaKind(
  cover: Creation,
  existingMemberIds: readonly string[],
  creationsById: Readonly<Record<string, Creation>>,
): "image" | "video" | null {
  const coverKind = mediaKind(cover);
  if (coverKind === "image" || coverKind === "video") return coverKind;

  const kinds = new Set(
    existingMemberIds
      .map((id) => mediaKind(creationsById[id]))
      .filter((k): k is "image" | "video" => k === "image" || k === "video"),
  );
  if (kinds.size === 1) return [...kinds][0];
  return null;
}

/** Map group member id → parent group cover id (from loaded cover rows). */
export function buildGroupMembershipByMemberId(
  creationsById: Readonly<Record<string, Creation>>,
): Map<string, { groupId: string }> {
  const map = new Map<string, { groupId: string }>();
  for (const creation of Object.values(creationsById)) {
    if (!isGroupCreation(creation)) continue;
    const groupId = creation.id.trim();
    if (!groupId) continue;
    for (const memberId of groupSourceCreationIds(creation)) {
      if (memberId === groupId) continue;
      map.set(memberId, { groupId });
    }
  }
  return map;
}

/**
 * Infer a single target group from the selection. Loose items must match the
 * group's member media type (image or video). Does not assume project context.
 */
export function resolveLibraryGroupAddTarget(opts: {
  assetIds: readonly string[];
  creationsById: Readonly<Record<string, Creation>>;
  groupMembershipByMemberId?: ReadonlyMap<string, { groupId: string }>;
}): LibraryGroupAddTarget | null {
  const membership =
    opts.groupMembershipByMemberId ??
    buildGroupMembershipByMemberId(opts.creationsById);
  const ids = [...new Set(opts.assetIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return null;

  const groupCoverIds = new Set<string>();
  const memberGroupIds = new Set<string>();
  const loose: string[] = [];

  for (const id of ids) {
    const creation = opts.creationsById[id];
    if (creation && isGroupCreation(creation)) {
      groupCoverIds.add(id);
      continue;
    }
    const parent = membership.get(id);
    if (parent) {
      memberGroupIds.add(parent.groupId);
      continue;
    }
    loose.push(id);
  }

  if (loose.length === 0) return null;

  const looseKinds = new Set(
    loose
      .map((id) => mediaKind(opts.creationsById[id]))
      .filter((k): k is "image" | "video" | "audio" => Boolean(k)),
  );
  if (looseKinds.size !== 1) return null;

  const targetIds = new Set([...groupCoverIds, ...memberGroupIds]);
  if (targetIds.size !== 1) return null;

  const groupId = [...targetIds][0];
  const cover = opts.creationsById[groupId];
  if (!cover || !isGroupCreation(cover)) return null;

  const memberMediaKind = groupMemberMediaKind(
    cover,
    groupSourceCreationIds(cover),
    opts.creationsById,
  );
  if (!memberMediaKind) return null;

  const memberIds = loose.filter((id) => {
    if (id === groupId) return false;
    if (membership.has(id)) return false;
    return mediaKind(opts.creationsById[id]) === memberMediaKind;
  });
  if (memberIds.length === 0) return null;

  const groupLabel =
    cover.title?.trim() ||
    (memberMediaKind === "image" ? "Images group" : "Videos group");

  return {
    groupId,
    groupLabel,
    memberMediaKind,
    memberIds,
  };
}
