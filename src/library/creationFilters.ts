import { isGroupCreation, isPublishedCreation } from "./creationFlags";
import { aspectRatioFromCreation } from "./aspectRatio";
import type { CatalogFilterCounts, Creation } from "./types";

/** Exclusive filter flags — at most one key is true (“All Assets” = all false). */
export type CreationFilterToggles = {
  video: boolean;
  image: boolean;
  audio: boolean;
  groups: boolean;
  localOnly: boolean;
  published: boolean;
  unpublished: boolean;
  selected: boolean;
  notSelected: boolean;
  inProject: boolean;
  aspect11: boolean;
  aspect916: boolean;
  aspect45: boolean;
  aspect169: boolean;
};

export const EMPTY_FILTER_TOGGLES: CreationFilterToggles = {
  video: false,
  image: false,
  audio: false,
  groups: false,
  localOnly: false,
  published: false,
  unpublished: false,
  selected: false,
  notSelected: false,
  inProject: false,
  aspect11: false,
  aspect916: false,
  aspect45: false,
  aspect169: false,
};

export type FilterId = keyof CreationFilterToggles | "all";

export function togglesFromFilterId(id: FilterId): CreationFilterToggles {
  if (id === "all") return { ...EMPTY_FILTER_TOGGLES };
  if (id in EMPTY_FILTER_TOGGLES) {
    return { ...EMPTY_FILTER_TOGGLES, [id]: true };
  }
  return { ...EMPTY_FILTER_TOGGLES };
}

export function isFilterId(value: unknown): value is FilterId {
  if (value === "all") return true;
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(EMPTY_FILTER_TOGGLES, value)
  );
}

export const ASPECT_FILTER_PRESETS = {
  aspect11: { w: 1, h: 1 },
  aspect916: { w: 9, h: 16 },
  aspect45: { w: 4, h: 5 },
  aspect169: { w: 16, h: 9 },
} as const;

export type AspectFilterId = keyof typeof ASPECT_FILTER_PRESETS;

/** Pack height / CSS aspect for folder tiles under an aspect filter (else 1:1). */
export function folderBoardAspect(toggles: CreationFilterToggles): {
  packHeight: number;
  aspectCss: string;
} {
  const active = activeFilterId(toggles);
  if (active in ASPECT_FILTER_PRESETS) {
    const { w, h } = ASPECT_FILTER_PRESETS[active as AspectFilterId];
    return { packHeight: h / w, aspectCss: `${w} / ${h}` };
  }
  return { packHeight: 1, aspectCss: "1 / 1" };
}

/**
 * Local-only = does not exist in Parascene cloud (desktop-origin).
 * Not the same as “downloaded / on disk.”
 */
export function isLocalOnlyCreation(
  c: Pick<Creation, "remoteUrl" | "remoteJson">,
): boolean {
  const remoteUrl = c.remoteUrl?.trim() ?? "";
  const remoteJson = c.remoteJson?.trim() ?? "";
  return !remoteUrl && !remoteJson;
}

export function creationMatchesAspectFilter(
  creation: Creation,
  id: AspectFilterId,
): boolean {
  const preset = ASPECT_FILTER_PRESETS[id];
  const { w, h } = aspectRatioFromCreation(creation);
  return w === preset.w && h === preset.h;
}

export function anyFilterActive(toggles: CreationFilterToggles): boolean {
  return (Object.keys(EMPTY_FILTER_TOGGLES) as (keyof CreationFilterToggles)[]).some(
    (key) => toggles[key],
  );
}

export function activeFilterId(toggles: CreationFilterToggles): FilterId {
  for (const key of Object.keys(EMPTY_FILTER_TOGGLES) as (keyof CreationFilterToggles)[]) {
    if (toggles[key]) return key;
  }
  return "all";
}

/** Single active filter match. */
export function creationMatchesFilters(
  creation: Creation,
  toggles: CreationFilterToggles,
  selectedIds: ReadonlySet<string>,
  inProjectIds: ReadonlySet<string> = emptyIdSet,
  /** Creations that belong inside a group — never match media-type filters. */
  groupMemberIds: ReadonlySet<string> = emptyIdSet,
): boolean {
  const active = activeFilterId(toggles);
  if (active === "all") return true;
  const mt = String(creation.mediaType ?? "").toLowerCase();
  const inGroup = groupMemberIds.has(creation.id);
  switch (active) {
    case "video":
      return mt === "video" && !isGroupCreation(creation) && !inGroup;
    case "image":
      return mt === "image" && !isGroupCreation(creation) && !inGroup;
    case "audio":
      return mt === "audio" && !isGroupCreation(creation) && !inGroup;
    case "groups":
      return isGroupCreation(creation);
    case "localOnly":
      return isLocalOnlyCreation(creation);
    case "published":
      return isPublishedCreation(creation);
    case "unpublished":
      return !isPublishedCreation(creation);
    case "selected":
      return selectedIds.has(creation.id);
    case "notSelected":
      return !selectedIds.has(creation.id);
    case "inProject":
      return inProjectIds.has(creation.id);
    case "aspect11":
    case "aspect916":
    case "aspect45":
    case "aspect169":
      return creationMatchesAspectFilter(creation, active);
    default:
      return true;
  }
}

const emptyIdSet: ReadonlySet<string> = new Set();

export function filterCreations(
  creations: Creation[],
  toggles: CreationFilterToggles,
  selectedIds: ReadonlySet<string>,
  inProjectIds: ReadonlySet<string> = emptyIdSet,
  groupMemberIds: ReadonlySet<string> = emptyIdSet,
): Creation[] {
  if (!anyFilterActive(toggles)) return creations;
  return creations.filter((c) =>
    creationMatchesFilters(
      c,
      toggles,
      selectedIds,
      inProjectIds,
      groupMemberIds,
    ),
  );
}

/**
 * Exclusive filter views that defer hide-on-toggle so masonry doesn't reflow:
 * - Not selected: keep newly selected items dimmed until leave
 * - Selected: keep newly deselected items dimmed until leave
 */
export function filterCreationsVisible(
  creations: Creation[],
  toggles: CreationFilterToggles,
  selectedIds: ReadonlySet<string>,
  deferredKeepIds: ReadonlySet<string>,
  inProjectIds: ReadonlySet<string> = emptyIdSet,
  groupMemberIds: ReadonlySet<string> = emptyIdSet,
): Creation[] {
  const active = activeFilterId(toggles);
  if (deferredKeepIds.size === 0) {
    return filterCreations(
      creations,
      toggles,
      selectedIds,
      inProjectIds,
      groupMemberIds,
    );
  }
  if (active === "notSelected") {
    return creations.filter((c) => {
      if (deferredKeepIds.has(c.id) && selectedIds.has(c.id)) return true;
      return creationMatchesFilters(
        c,
        toggles,
        selectedIds,
        inProjectIds,
        groupMemberIds,
      );
    });
  }
  if (active === "selected") {
    return creations.filter((c) => {
      if (deferredKeepIds.has(c.id) && !selectedIds.has(c.id)) return true;
      return creationMatchesFilters(
        c,
        toggles,
        selectedIds,
        inProjectIds,
        groupMemberIds,
      );
    });
  }
  return filterCreations(
    creations,
    toggles,
    selectedIds,
    inProjectIds,
    groupMemberIds,
  );
}

/** Filters that need member creation rows to decide if a folder matches. */
export function folderNeedsMemberCreations(
  toggles: CreationFilterToggles,
): boolean {
  const active = activeFilterId(toggles);
  switch (active) {
    case "video":
    case "image":
    case "audio":
    case "groups":
    case "localOnly":
    case "published":
    case "unpublished":
    case "aspect11":
    case "aspect916":
    case "aspect45":
    case "aspect169":
      return true;
    default:
      return false;
  }
}

/**
 * Folder matches the active filter when any member matches (or the folder
 * itself for selection / in-project).
 */
export function folderMatchesFilters(
  folder: { id: string; memberIds: readonly string[] },
  toggles: CreationFilterToggles,
  selectedIds: ReadonlySet<string>,
  selectedFolderIds: ReadonlySet<string>,
  inProjectIds: ReadonlySet<string> = emptyIdSet,
  projectFolderIds: ReadonlySet<string> = emptyIdSet,
  creationsById: ReadonlyMap<string, Creation> = emptyCreationMap,
  groupMemberIds: ReadonlySet<string> = emptyIdSet,
): boolean {
  const active = activeFilterId(toggles);
  if (active === "all") return true;

  if (active === "selected") {
    if (selectedFolderIds.has(folder.id)) return true;
    return folder.memberIds.some((id) => selectedIds.has(id));
  }
  if (active === "notSelected") {
    if (selectedFolderIds.has(folder.id)) return false;
    return folder.memberIds.every((id) => !selectedIds.has(id));
  }
  if (active === "inProject") {
    if (projectFolderIds.has(folder.id)) return true;
    return folder.memberIds.some((id) => inProjectIds.has(id));
  }

  if (folder.memberIds.length === 0) return false;

  for (const id of folder.memberIds) {
    const creation = creationsById.get(id);
    if (!creation) continue;
    if (
      creationMatchesFilters(
        creation,
        toggles,
        selectedIds,
        inProjectIds,
        groupMemberIds,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Up to 4 member ids whose previews should appear on a folder tile. */
export function folderCollageMemberIds(
  folder: { id: string; memberIds: readonly string[] },
  toggles: CreationFilterToggles,
  selectedIds: ReadonlySet<string>,
  selectedFolderIds: ReadonlySet<string>,
  inProjectIds: ReadonlySet<string> = emptyIdSet,
  projectFolderIds: ReadonlySet<string> = emptyIdSet,
  creationsById: ReadonlyMap<string, Creation> = emptyCreationMap,
  limit = 4,
  groupMemberIds: ReadonlySet<string> = emptyIdSet,
): string[] {
  const active = activeFilterId(toggles);
  if (active === "all") return folder.memberIds.slice(0, limit);

  if (active === "selected") {
    const selectedMembers = folder.memberIds.filter((id) => selectedIds.has(id));
    if (selectedMembers.length > 0) return selectedMembers.slice(0, limit);
    // Folder tile selected but no selected members — keep generic collage.
    if (selectedFolderIds.has(folder.id)) {
      return folder.memberIds.slice(0, limit);
    }
    return [];
  }
  if (active === "notSelected") {
    return folder.memberIds
      .filter((id) => !selectedIds.has(id))
      .slice(0, limit);
  }
  if (active === "inProject") {
    const inProjectMembers = folder.memberIds.filter((id) =>
      inProjectIds.has(id),
    );
    if (inProjectMembers.length > 0) return inProjectMembers.slice(0, limit);
    if (projectFolderIds.has(folder.id)) {
      return folder.memberIds.slice(0, limit);
    }
    return [];
  }

  const matching: string[] = [];
  for (const id of folder.memberIds) {
    const creation = creationsById.get(id);
    if (!creation) continue;
    if (
      !creationMatchesFilters(
        creation,
        toggles,
        selectedIds,
        inProjectIds,
        groupMemberIds,
      )
    ) {
      continue;
    }
    matching.push(id);
    if (matching.length >= limit) break;
  }
  return matching;
}

const emptyCreationMap: ReadonlyMap<string, Creation> = new Map();

export type FilterCounts = Record<keyof CreationFilterToggles, number> & {
  all: number;
};

/** Merge SQLite catalog tallies with selection / open-project counts from the UI. */
export function mergeFilterCounts(
  catalog: CatalogFilterCounts | null,
  selectedIds: ReadonlySet<string>,
  inProjectIds: ReadonlySet<string> = emptyIdSet,
): FilterCounts {
  const all = catalog?.all ?? 0;
  const selected = selectedIds.size;
  return {
    all,
    video: catalog?.video ?? 0,
    image: catalog?.image ?? 0,
    audio: catalog?.audio ?? 0,
    groups: catalog?.groups ?? 0,
    localOnly: catalog?.localOnly ?? 0,
    published: catalog?.published ?? 0,
    unpublished: catalog?.unpublished ?? 0,
    selected,
    notSelected: Math.max(0, all - selected),
    inProject: inProjectIds.size,
    aspect11: catalog?.aspect11 ?? 0,
    aspect916: catalog?.aspect916 ?? 0,
    aspect45: catalog?.aspect45 ?? 0,
    aspect169: catalog?.aspect169 ?? 0,
  };
}

/** Loaded-window tallies (tests / fallback). Prefer mergeFilterCounts for sidebar. */
export function countFilterMatches(
  creations: Creation[],
  selectedIds: ReadonlySet<string>,
  inProjectIds: ReadonlySet<string> = emptyIdSet,
): FilterCounts {
  const counts: FilterCounts = {
    all: creations.length,
    video: 0,
    image: 0,
    audio: 0,
    groups: 0,
    localOnly: 0,
    published: 0,
    unpublished: 0,
    selected: 0,
    notSelected: 0,
    inProject: 0,
    aspect11: 0,
    aspect916: 0,
    aspect45: 0,
    aspect169: 0,
  };
  for (const c of creations) {
    const mt = String(c.mediaType ?? "").toLowerCase();
    const group = isGroupCreation(c);
    if (mt === "video" && !group) counts.video += 1;
    else if (mt === "image" && !group) counts.image += 1;
    else if (mt === "audio" && !group) counts.audio += 1;
    if (group) counts.groups += 1;
    if (isLocalOnlyCreation(c)) counts.localOnly += 1;
    if (isPublishedCreation(c)) counts.published += 1;
    else counts.unpublished += 1;
    if (selectedIds.has(c.id)) counts.selected += 1;
    else counts.notSelected += 1;
    if (inProjectIds.has(c.id)) counts.inProject += 1;
    if (creationMatchesAspectFilter(c, "aspect11")) counts.aspect11 += 1;
    if (creationMatchesAspectFilter(c, "aspect916")) counts.aspect916 += 1;
    if (creationMatchesAspectFilter(c, "aspect45")) counts.aspect45 += 1;
    if (creationMatchesAspectFilter(c, "aspect169")) counts.aspect169 += 1;
  }
  return counts;
}

/**
 * One filter at a time. Clicking All Assets (or the active filter again) clears to all.
 */
export function selectFilter(
  toggles: CreationFilterToggles,
  id: FilterId,
): CreationFilterToggles {
  if (id === "all") return { ...EMPTY_FILTER_TOGGLES };
  if (toggles[id]) return { ...EMPTY_FILTER_TOGGLES };
  return { ...EMPTY_FILTER_TOGGLES, [id]: true };
}

/** @deprecated Use selectFilter — filters are exclusive. */
export function toggleFilter(
  toggles: CreationFilterToggles,
  id: FilterId,
): CreationFilterToggles {
  return selectFilter(toggles, id);
}
