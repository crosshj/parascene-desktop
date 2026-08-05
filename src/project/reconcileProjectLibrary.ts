/**
 * After Library catalog/folder sync, merge newly discovered creation ids into
 * stored projects (cabinets + folder members only), and strip ordinary group
 * members that were incorrectly expanded into `creationIds`.
 */

import { getCreations, listGroupMemberIds } from "../library/catalogClient";
import {
  groupSourceCreationIds,
  isGroupCreation,
} from "../library/creationFlags";
import { listFolders, type LibraryFolder } from "../library/folderClient";
import {
  loadStoredProjects,
  mergeCreationIds,
  normalizeFolderIds,
  normalizeStoredTimeline,
  removeCreationIds,
  saveStoredProjects,
  type StoredProject,
} from "./projectStore";

function cabinetIdsFor(project: StoredProject): string[] {
  return [project.imagesGroupId, project.videosGroupId]
    .map((id) => (id ? String(id).trim() : ""))
    .filter(Boolean);
}

/** Ids that must stay even if they also appear inside an ordinary group. */
export function collectProtectedCreationIds(project: StoredProject): Set<string> {
  const out = new Set<string>();
  const add = (id: string | null | undefined) => {
    const next = id?.trim();
    if (next) out.add(next);
  };

  add(project.mainAudioCreationId);
  add(project.selectedAssetId);
  add(project.lyricAlignment?.sourceAudioCreationId);
  add(project.storyboardProposal?.sourceAudioCreationId);

  for (const clip of normalizeStoredTimeline(project.timeline)) {
    add(clip.assetId);
    add(clip.slideshow?.audioAssetId);
    for (const imageId of clip.slideshow?.imageAssetIds ?? []) add(imageId);
  }

  return out;
}

/**
 * Cover ids that should be refreshed from the Parascene list after sync:
 * project Images/Videos cabinets plus any group covers filed in project folders.
 */
export async function collectProjectGroupCoverIdsToRefresh(
  projects: readonly StoredProject[],
  folders?: readonly LibraryFolder[],
): Promise<string[]> {
  const folderList = folders ?? (await listFolders());
  const byFolderId = new Map(folderList.map((f) => [f.id, f]));
  const seeds = new Set<string>();

  for (const project of projects) {
    for (const id of cabinetIdsFor(project)) seeds.add(id);
    for (const folderId of normalizeFolderIds(project.folderIds)) {
      const folder = byFolderId.get(folderId);
      if (!folder) continue;
      for (const memberId of folder.memberIds) seeds.add(memberId);
    }
    const boundId = project.boundFolderId?.trim();
    if (boundId) {
      const folder = byFolderId.get(boundId);
      if (folder) {
        for (const memberId of folder.memberIds) seeds.add(memberId);
      }
    }
  }

  if (seeds.size === 0) return [];
  const rows = await getCreations([...seeds]);
  const covers = new Set<string>();
  for (const project of projects) {
    for (const id of cabinetIdsFor(project)) covers.add(id);
  }
  for (const row of rows) {
    if (isGroupCreation(row)) covers.add(row.id);
  }
  return [...covers];
}

/**
 * Creation ids that belong on the project after sync but may be missing from
 * `creationIds`: folder members (covers stay covers) and **Images/Videos
 * cabinet** members only. Ordinary groups are not expanded into the project.
 */
export async function collectCreationIdsToMergeForProject(
  project: StoredProject,
  folders?: readonly LibraryFolder[],
): Promise<string[]> {
  const folderList = folders ?? (await listFolders());
  const byFolderId = new Map(folderList.map((f) => [f.id, f]));
  const candidates = new Set<string>();
  const cabinets = cabinetIdsFor(project);

  for (const id of cabinets) candidates.add(id);

  for (const folderId of normalizeFolderIds(project.folderIds)) {
    const folder = byFolderId.get(folderId);
    if (!folder) continue;
    for (const memberId of folder.memberIds) candidates.add(memberId);
  }

  const boundId = project.boundFolderId?.trim();
  if (boundId) {
    const folder = byFolderId.get(boundId);
    if (folder) {
      for (const memberId of folder.memberIds) candidates.add(memberId);
    }
  }

  if (candidates.size === 0) return [];

  // Only project source cabinets expand to members — not every group cover.
  if (cabinets.length > 0) {
    const covers = await getCreations(cabinets);
    const cabinetSet = new Set(cabinets);
    for (const row of covers) {
      if (!cabinetSet.has(row.id)) continue;
      for (const mid of groupSourceCreationIds(row)) candidates.add(mid);
    }
  }

  const known = new Set(project.creationIds);
  return [...candidates].filter((id) => id && !known.has(id));
}

/**
 * Members of ordinary (non-cabinet) groups that were flattened onto the project
 * and are safe to remove: not folder covers, not cabinet members, not used by
 * timeline / main audio / storyboard.
 *
 * Uses the catalog-wide group-member index so we still heal when a cover is
 * missing from `creationIds` or only some of its members were merged.
 */
export async function collectExtraneousExpandedGroupMemberIds(
  project: StoredProject,
  folders?: readonly LibraryFolder[],
): Promise<string[]> {
  const folderList = folders ?? (await listFolders());
  const byFolderId = new Map(folderList.map((f) => [f.id, f]));
  const cabinets = new Set(cabinetIdsFor(project));
  const keep = new Set<string>([
    ...cabinets,
    ...collectProtectedCreationIds(project),
  ]);

  for (const folderId of normalizeFolderIds(project.folderIds)) {
    const folder = byFolderId.get(folderId);
    if (!folder) continue;
    // Folder filings stay as whatever was filed (usually group covers).
    for (const memberId of folder.memberIds) keep.add(memberId);
  }

  const boundId = project.boundFolderId?.trim();
  if (boundId) {
    const folder = byFolderId.get(boundId);
    if (folder) {
      for (const memberId of folder.memberIds) keep.add(memberId);
    }
  }

  if (cabinets.size > 0) {
    const covers = await getCreations([...cabinets]);
    for (const row of covers) {
      for (const mid of groupSourceCreationIds(row)) keep.add(mid);
    }
  }

  const groupMemberIds = await listGroupMemberIds();
  if (groupMemberIds.length === 0) return [];

  const known = new Set(project.creationIds);
  const extraneous: string[] = [];
  for (const mid of groupMemberIds) {
    if (!known.has(mid) || keep.has(mid) || cabinets.has(mid)) continue;
    extraneous.push(mid);
  }
  return extraneous;
}

export type ReconcileProjectsResult = {
  projectsUpdated: number;
  creationsMerged: number;
  creationsRemoved: number;
};

/**
 * Strip mistaken ordinary-group expansions, then merge missing folder/cabinet
 * members into every stored project's `creationIds`.
 */
export async function reconcileStoredProjectsFromLibrary(
  projects: readonly StoredProject[],
): Promise<{ projects: StoredProject[]; result: ReconcileProjectsResult }> {
  const folders = await listFolders();
  let projectsUpdated = 0;
  let creationsMerged = 0;
  let creationsRemoved = 0;
  const next: StoredProject[] = [];

  for (const project of projects) {
    const extraneous = await collectExtraneousExpandedGroupMemberIds(
      project,
      folders,
    );
    let working =
      extraneous.length > 0 ? removeCreationIds(project, extraneous) : project;
    if (extraneous.length > 0) {
      creationsRemoved += extraneous.length;
    }

    const missing = await collectCreationIdsToMergeForProject(working, folders);
    if (missing.length > 0) {
      working = mergeCreationIds(working, missing);
      creationsMerged += missing.length;
    }

    if (working !== project) {
      projectsUpdated += 1;
    }
    next.push(working);
  }

  return {
    projects: next,
    result: { projectsUpdated, creationsMerged, creationsRemoved },
  };
}

/** Load → reconcile → save. Returns how many creations were merged/removed. */
export async function reconcileAndSaveStoredProjects(): Promise<ReconcileProjectsResult> {
  const loaded = loadStoredProjects();
  const { projects, result } = await reconcileStoredProjectsFromLibrary(loaded);
  if (result.projectsUpdated > 0) {
    saveStoredProjects(projects);
  }
  return result;
}
