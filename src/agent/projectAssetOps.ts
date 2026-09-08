import { getCreation, getCreations } from "../library/catalogClient";
import { groupSourceCreationIds } from "../library/creationFlags";
import { isLocalOnlyCreation } from "../library/creationFilters";
import {
  memberIdsFromRemoteGroup,
  removeMembersFromProjectGroup,
  ungroupMembersFromProjectGroup,
} from "../lab/projectGroups";
import { cabinetPersistPatch } from "../project/cabinetPersist";
import {
  deleteCreationViaService,
  getRemoteCreation,
} from "../services/parasceneCatalog";

export type TimelineAssetClip = {
  assetId?: string | null;
  addAssetGeneration?: {
    creationId?: string | null;
    startFrameAssetId?: string | null;
    firstFrameSource?: { kind?: string; assetId?: string } | null;
    lastFrameSource?: { kind?: string; assetId?: string } | null;
  } | null;
  addAssetDraft?: {
    startFrameAssetId?: string | null;
    firstFrameSource?: { kind?: string; assetId?: string } | null;
    lastFrameSource?: { kind?: string; assetId?: string } | null;
  } | null;
  slideshow?: {
    imageAssetIds?: readonly string[] | null;
    audioAssetId?: string | null;
  } | null;
};

export class TimelineAssetInUseError extends Error {
  readonly usedIds: string[];

  constructor(usedIds: string[]) {
    const n = usedIds.length;
    super(
      n === 1
        ? "This asset is used on the timeline. Remove its clips first, then try again."
        : `${n} selected assets are used on the timeline. Remove their clips first, then try again.`,
    );
    this.name = "TimelineAssetInUseError";
    this.usedIds = usedIds;
  }
}

export function collectTimelineUsedAssetIds(
  timeline: readonly TimelineAssetClip[],
): Set<string> {
  const used = new Set<string>();
  const add = (id?: string | null) => {
    const trimmed = id?.trim();
    if (trimmed) used.add(trimmed);
  };
  const frameId = (
    source?: { kind?: string; assetId?: string } | null,
  ): string => (source?.kind === "asset" ? (source.assetId ?? "") : "");

  for (const clip of timeline) {
    add(clip.assetId);
    add(clip.addAssetGeneration?.creationId);
    for (const id of clip.slideshow?.imageAssetIds ?? []) add(id);
    add(clip.slideshow?.audioAssetId);
    add(clip.addAssetGeneration?.startFrameAssetId);
    add(clip.addAssetDraft?.startFrameAssetId);
    add(frameId(clip.addAssetGeneration?.firstFrameSource));
    add(frameId(clip.addAssetDraft?.firstFrameSource));
    add(frameId(clip.addAssetGeneration?.lastFrameSource));
    add(frameId(clip.addAssetDraft?.lastFrameSource));
  }
  return used;
}

export function assertAssetsNotOnTimeline(
  ids: readonly string[],
  used: ReadonlySet<string>,
): void {
  const blocked = ids.map((id) => id.trim()).filter((id) => id && used.has(id));
  if (blocked.length > 0) {
    throw new TimelineAssetInUseError([...new Set(blocked)]);
  }
}

export type ClassifiedProjectAssets = {
  imagesMemberIds: string[];
  videosMemberIds: string[];
  standaloneIds: string[];
};

export function classifyProjectAssetIds(
  ids: readonly string[],
  cabinets: {
    imagesGroupId: string | null;
    videosGroupId: string | null;
    imagesMemberIds: readonly string[];
    videosMemberIds: readonly string[];
  },
): ClassifiedProjectAssets {
  const imagesCover = (cabinets.imagesGroupId ?? "").trim();
  const videosCover = (cabinets.videosGroupId ?? "").trim();
  const imagesMembers = new Set(
    cabinets.imagesMemberIds.map((id) => id.trim()).filter(Boolean),
  );
  const videosMembers = new Set(
    cabinets.videosMemberIds.map((id) => id.trim()).filter(Boolean),
  );
  const images = new Set<string>();
  const videos = new Set<string>();
  const standalone: string[] = [];
  const seen = new Set<string>();

  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (id === imagesCover) {
      for (const memberId of imagesMembers) images.add(memberId);
      continue;
    }
    if (id === videosCover) {
      for (const memberId of videosMembers) videos.add(memberId);
      continue;
    }
    if (imagesMembers.has(id)) {
      images.add(id);
      continue;
    }
    if (videosMembers.has(id)) {
      videos.add(id);
      continue;
    }
    standalone.push(id);
  }

  return {
    imagesMemberIds: [...images],
    videosMemberIds: [...videos],
    standaloneIds: standalone,
  };
}

export type ProjectAssetOpContext = {
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  timelineUsedIds: ReadonlySet<string>;
  removeCreationsFromOpenProject: (ids: string[]) => Promise<void>;
  addCreationsToOpenProject: (ids: string[]) => Promise<void>;
  deleteLibraryCreation: (id: string) => Promise<void>;
  setOpenProjectGroupIds: (patch: {
    imagesGroupId?: string | null;
    videosGroupId?: string | null;
  }) => void;
  /**
   * One persist write: cabinet pointers + hide/add creationIds.
   * Must land before native unfile so Editor remount cannot bounce a cover.
   */
  persistOpenProjectAfterAssets?: (patch: {
    imagesGroupId: string | null;
    videosGroupId: string | null;
    hideIds: string[];
    addIds?: string[];
  }) => Promise<void>;
  onProgress?: (note: string) => void;
};

export type ProjectAssetOpResult = {
  ids: string[];
  imagesGroupId: string | null;
  videosGroupId: string | null;
};

async function loadCabinetMemberIds(groupId: string | null): Promise<string[]> {
  const id = groupId?.trim() ?? "";
  if (!id) return [];
  try {
    const cover = (await getCreations([id]))[0];
    const fromLocal = cover ? groupSourceCreationIds(cover) : [];
    if (fromLocal.length > 0) return fromLocal;
  } catch {
    /* remote fallback */
  }
  try {
    return memberIdsFromRemoteGroup(await getRemoteCreation(id));
  } catch {
    return [];
  }
}

async function persistThenUnfile(
  ctx: ProjectAssetOpContext,
  imagesGroupId: string | null,
  videosGroupId: string | null,
  toUnfile: string[],
  toAdd: string[],
): Promise<void> {
  const persist = cabinetPersistPatch({
    imagesGroupId,
    videosGroupId,
    hideIds: toUnfile,
    addIds: toAdd,
  });
  if (ctx.persistOpenProjectAfterAssets) {
    await ctx.persistOpenProjectAfterAssets(persist);
  } else {
    ctx.setOpenProjectGroupIds({
      imagesGroupId: persist.imagesGroupId,
      videosGroupId: persist.videosGroupId,
    });
  }
  if (toUnfile.length > 0) {
    await ctx.removeCreationsFromOpenProject(toUnfile);
  }
  const add = persist.addIds.filter((id) => !toUnfile.includes(id));
  if (add.length > 0) {
    await ctx.addCreationsToOpenProject(add);
  }
  if (!ctx.persistOpenProjectAfterAssets) {
    ctx.setOpenProjectGroupIds({
      imagesGroupId: persist.imagesGroupId,
      videosGroupId: persist.videosGroupId,
    });
  }
}

async function dropEmptiedCovers(
  ctx: ProjectAssetOpContext,
  previous: { imagesGroupId: string | null; videosGroupId: string | null },
  next: { imagesGroupId: string | null; videosGroupId: string | null },
  keepIds: ReadonlySet<string>,
): Promise<void> {
  const emptied = [previous.imagesGroupId, previous.videosGroupId]
    .map((id) => id?.trim() ?? "")
    .filter((id) => {
      if (!id || keepIds.has(id)) return false;
      return (
        id !== (next.imagesGroupId ?? "").trim() &&
        id !== (next.videosGroupId ?? "").trim()
      );
    });
  for (const id of emptied) {
    try {
      await ctx.deleteLibraryCreation(id);
    } catch {
      /* archived cover may still be referenced until the next persist */
    }
  }
}

async function applyCabinetMutation(
  ctx: ProjectAssetOpContext,
  kind: "images" | "videos",
  groupId: string,
  memberIds: string[],
  mode: "remove" | "delete",
): Promise<{
  groupId: string | null;
  unfile: string[];
  add: string[];
}> {
  if (memberIds.length === 0) {
    return { groupId, unfile: [], add: [] };
  }
  const mutate =
    mode === "remove"
      ? ungroupMembersFromProjectGroup
      : removeMembersFromProjectGroup;
  const result = await mutate({
    projectId: ctx.projectId,
    projectTitle: ctx.projectTitle,
    kind,
    groupId,
    memberIds,
    onProgress: ctx.onProgress,
  });
  return {
    groupId: result.groupId,
    unfile: result.projectCreationIdsToRemove,
    add: result.projectCreationIdsToAdd,
  };
}

export async function applyProjectAssetRemove(
  ctx: ProjectAssetOpContext,
  assetIds: readonly string[],
): Promise<ProjectAssetOpResult> {
  const ids = [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return {
      ids,
      imagesGroupId: ctx.imagesGroupId,
      videosGroupId: ctx.videosGroupId,
    };
  }
  assertAssetsNotOnTimeline(ids, ctx.timelineUsedIds);

  const imagesMembers = await loadCabinetMemberIds(ctx.imagesGroupId);
  const videosMembers = await loadCabinetMemberIds(ctx.videosGroupId);
  const classified = classifyProjectAssetIds(ids, {
    imagesGroupId: ctx.imagesGroupId,
    videosGroupId: ctx.videosGroupId,
    imagesMemberIds: imagesMembers,
    videosMemberIds: videosMembers,
  });

  let imagesGroupId = ctx.imagesGroupId;
  let videosGroupId = ctx.videosGroupId;
  const unfile = new Set<string>(ids);
  const add = new Set<string>();

  if (classified.imagesMemberIds.length > 0 && imagesGroupId) {
    const result = await applyCabinetMutation(
      ctx,
      "images",
      imagesGroupId,
      classified.imagesMemberIds,
      "remove",
    );
    imagesGroupId = result.groupId;
    for (const id of result.unfile) unfile.add(id);
    for (const id of result.add) add.add(id);
  }
  if (classified.videosMemberIds.length > 0 && videosGroupId) {
    const result = await applyCabinetMutation(
      ctx,
      "videos",
      videosGroupId,
      classified.videosMemberIds,
      "remove",
    );
    videosGroupId = result.groupId;
    for (const id of result.unfile) unfile.add(id);
    for (const id of result.add) add.add(id);
  }

  const toUnfile = [...unfile];
  const toAdd = [...add].filter((id) => !unfile.has(id));
  const persist = cabinetPersistPatch({
    imagesGroupId,
    videosGroupId,
    hideIds: toUnfile,
    addIds: toAdd,
  });
  await persistThenUnfile(
    ctx,
    persist.imagesGroupId,
    persist.videosGroupId,
    toUnfile,
    persist.addIds,
  );
  await dropEmptiedCovers(
    ctx,
    {
      imagesGroupId: ctx.imagesGroupId,
      videosGroupId: ctx.videosGroupId,
    },
    {
      imagesGroupId: persist.imagesGroupId,
      videosGroupId: persist.videosGroupId,
    },
    new Set(ids),
  );
  return {
    ids,
    imagesGroupId: persist.imagesGroupId,
    videosGroupId: persist.videosGroupId,
  };
}

export async function applyProjectAssetDelete(
  ctx: ProjectAssetOpContext,
  assetIds: readonly string[],
): Promise<ProjectAssetOpResult> {
  const ids = [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return {
      ids,
      imagesGroupId: ctx.imagesGroupId,
      videosGroupId: ctx.videosGroupId,
    };
  }
  assertAssetsNotOnTimeline(ids, ctx.timelineUsedIds);

  const imagesMembers = await loadCabinetMemberIds(ctx.imagesGroupId);
  const videosMembers = await loadCabinetMemberIds(ctx.videosGroupId);
  const classified = classifyProjectAssetIds(ids, {
    imagesGroupId: ctx.imagesGroupId,
    videosGroupId: ctx.videosGroupId,
    imagesMemberIds: imagesMembers,
    videosMemberIds: videosMembers,
  });

  let imagesGroupId = ctx.imagesGroupId;
  let videosGroupId = ctx.videosGroupId;
  const unfile = new Set<string>(ids);
  const add = new Set<string>();
  const deleted = new Set<string>();

  if (classified.imagesMemberIds.length > 0 && imagesGroupId) {
    const result = await applyCabinetMutation(
      ctx,
      "images",
      imagesGroupId,
      classified.imagesMemberIds,
      "delete",
    );
    imagesGroupId = result.groupId;
    for (const id of result.unfile) unfile.add(id);
    for (const id of result.add) add.add(id);
    for (const id of classified.imagesMemberIds) deleted.add(id);
  }
  if (classified.videosMemberIds.length > 0 && videosGroupId) {
    const result = await applyCabinetMutation(
      ctx,
      "videos",
      videosGroupId,
      classified.videosMemberIds,
      "delete",
    );
    videosGroupId = result.groupId;
    for (const id of result.unfile) unfile.add(id);
    for (const id of result.add) add.add(id);
    for (const id of classified.videosMemberIds) deleted.add(id);
  }

  for (const id of classified.standaloneIds) {
    const row = await getCreation(id).catch(() => null);
    if (row && !isLocalOnlyCreation(row)) {
      ctx.onProgress?.(`Deleting ${id} on Parascene…`);
      await deleteCreationViaService(id);
    }
    await ctx.deleteLibraryCreation(id);
    deleted.add(id);
    unfile.add(id);
  }

  const toUnfile = [...unfile];
  const toAdd = [...add].filter((id) => !unfile.has(id) && !deleted.has(id));
  const persist = cabinetPersistPatch({
    imagesGroupId,
    videosGroupId,
    hideIds: toUnfile,
    addIds: toAdd,
  });
  await persistThenUnfile(
    ctx,
    persist.imagesGroupId,
    persist.videosGroupId,
    toUnfile,
    persist.addIds,
  );
  await dropEmptiedCovers(
    ctx,
    {
      imagesGroupId: ctx.imagesGroupId,
      videosGroupId: ctx.videosGroupId,
    },
    {
      imagesGroupId: persist.imagesGroupId,
      videosGroupId: persist.videosGroupId,
    },
    new Set(),
  );
  // Cabinet deleteLocal often fails while the cover still has usage.
  // Retry after the pointer is cleared and the ids are unfiled.
  for (const id of deleted) {
    try {
      await ctx.deleteLibraryCreation(id);
    } catch {
      /* already gone, or a leftover usage we could not drop */
    }
  }
  return {
    ids,
    imagesGroupId: persist.imagesGroupId,
    videosGroupId: persist.videosGroupId,
  };
}
