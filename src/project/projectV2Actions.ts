import type { LibraryFolder } from "../library/folderClient";
import type { Creation } from "../library/types";
import { existingCreationIds } from "../library/catalogClient";
import {
  assetIdsFromProjectV2Items,
  coverAssetIdFromV2Items,
  isParasceneCreationId,
  isProjectV2Creation,
  isStoredProjectV2,
  localUri,
  parasceneIdFromV2FolderId,
  parseProjectV2Remote,
  projectV2ItemsFromCreation,
  v2FolderId,
  type ProjectV2Pointer,
} from "./projectV2";
import {
  createProjectV2,
  ensureLibraryId,
  getProjectV2,
  ingestProjectV2Snapshot,
  patchProjectV2,
  pointerPayload,
  type ProjectV2Remote,
} from "./projectV2Client";
import {
  createStoredProject,
  replaceStoredProjectAssets,
  type StoredProject,
} from "./projectStore";

export function applyV2RemoteToStored(
  project: StoredProject,
  remote: ProjectV2Remote,
  libraryId: string,
): StoredProject {
  return {
    ...replaceStoredProjectAssets(
      project,
      assetIdsFromProjectV2Items(remote.items, libraryId),
    ),
    title: remote.title.trim() || project.title,
    containerVersion: "v2",
    parasceneProjectId: remote.id,
    coverCreationId: coverAssetIdFromV2Items(remote.items, libraryId),
    updatedAt: new Date().toISOString(),
    lifecycle: "ready",
    folderSetupIssue: null,
    folderIds: [],
    boundFolderId: null,
    imagesGroupId: null,
    videosGroupId: null,
  };
}

/** Keep timeline / placeholder writes; take only the remote membership fields. */
export function overlayV2RemoteMembership(
  project: StoredProject,
  remoteApplied: StoredProject,
): StoredProject {
  return {
    ...replaceStoredProjectAssets(project, remoteApplied.creationIds),
    title: remoteApplied.title.trim() || project.title,
    coverCreationId: remoteApplied.coverCreationId,
    containerVersion: remoteApplied.containerVersion ?? project.containerVersion,
    parasceneProjectId:
      remoteApplied.parasceneProjectId ?? project.parasceneProjectId,
  };
}

/** Ids that are safe to PATCH onto a project right now. */
export async function catalogedCreationIdsToAdd(
  creationIds: readonly string[],
): Promise<string[]> {
  const unique = [
    ...new Set(creationIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (unique.length === 0) return [];
  const existing = new Set(await existingCreationIds(unique));
  return unique.filter((id) => existing.has(id));
}

export async function fetchAndApplyV2(
  project: StoredProject,
): Promise<StoredProject> {
  const id = project.parasceneProjectId?.trim();
  if (!id) throw new Error("Project is missing its Parascene id.");
  const remote = await getProjectV2(id);
  await ingestProjectV2Snapshot(remote.raw);
  const libraryId = await ensureLibraryId();
  return applyV2RemoteToStored(project, remote, libraryId);
}

export function removeBodyForCreationIds(
  creationIds: readonly string[],
  libraryId: string,
): Array<string | Record<string, unknown>> {
  const out: Array<string | Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const raw of creationIds) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (isParasceneCreationId(id)) {
      out.push(id);
      continue;
    }
    const uri = localUri(libraryId, id);
    out.push(uri ?? id);
  }
  return out;
}

/** Ids that are not already on the v2 list. PATCH-add of a member duplicates the pair. */
export function membershipIdsToAdd(
  existingIds: readonly string[],
  requested: readonly string[],
): string[] {
  const have = new Set(
    existingIds.map((id) => id.trim()).filter(Boolean),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const id = raw.trim();
    if (!id || seen.has(id) || have.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function addBodyForCreationIds(
  creationIds: readonly string[],
  libraryId: string,
): Array<string | Record<string, unknown>> {
  const out: Array<string | Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const raw of creationIds) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (isParasceneCreationId(id)) {
      out.push(id);
      continue;
    }
    const uri = localUri(libraryId, id);
    if (!uri) continue;
    out.push({
      pointer: pointerPayload({
        kind: "local",
        uri,
        libraryId,
        assetId: id,
      }),
    });
  }
  return out;
}

export function seedItemsForCreate(
  creationIds: readonly string[],
  libraryId: string,
): {
  ids: string[];
  items: Array<{ pointer: ProjectV2Pointer; cover?: boolean }>;
} {
  const ids: string[] = [];
  const items: Array<{ pointer: ProjectV2Pointer; cover?: boolean }> = [];
  const seen = new Set<string>();
  for (const raw of creationIds) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (isParasceneCreationId(id)) {
      ids.push(id);
      continue;
    }
    const uri = localUri(libraryId, id);
    if (!uri) continue;
    items.push({
      pointer: { kind: "local", uri, libraryId, assetId: id },
      cover: ids.length === 0 && items.length === 0,
    });
  }
  return { ids, items };
}

export async function mintProjectV2(opts: {
  title: string;
  creationIds?: readonly string[];
}): Promise<ProjectV2Remote> {
  const libraryId = await ensureLibraryId();
  const seeded = seedItemsForCreate(opts.creationIds ?? [], libraryId);
  return createProjectV2({
    title: opts.title,
    ids: seeded.ids,
    items: seeded.items,
  });
}

export async function patchV2Membership(
  project: StoredProject,
  body: {
    add?: readonly string[];
    remove?: readonly string[];
    title?: string;
  },
): Promise<StoredProject> {
  const id = project.parasceneProjectId?.trim();
  if (!id) throw new Error("Project is missing its Parascene id.");
  const libraryId = await ensureLibraryId();
  let add = body.add ? [...body.add] : [];
  if (add.length > 0) {
    const current = await getProjectV2(id);
    add = membershipIdsToAdd(
      assetIdsFromProjectV2Items(current.items, libraryId),
      add,
    );
    if (
      add.length === 0 &&
      !(body.remove && body.remove.length > 0) &&
      body.title == null
    ) {
      await ingestProjectV2Snapshot(current.raw);
      return applyV2RemoteToStored(project, current, libraryId);
    }
  }
  const remote = await patchProjectV2(id, {
    ...(body.title != null ? { title: body.title } : {}),
    ...(add.length > 0 ? { add: addBodyForCreationIds(add, libraryId) } : {}),
    ...(body.remove && body.remove.length > 0
      ? { remove: removeBodyForCreationIds(body.remove, libraryId) }
      : {}),
  });
  await ingestProjectV2Snapshot(remote.raw);
  return applyV2RemoteToStored(project, remote, libraryId);
}

export async function setProjectV2Cover(
  project: StoredProject,
  creationId: string,
): Promise<StoredProject> {
  const id = project.parasceneProjectId?.trim();
  if (!id) throw new Error("Project is missing its Parascene id.");
  const cover = creationId.trim();
  if (!cover) throw new Error("Cover creation id is required.");
  const remote = await patchProjectV2(id, { cover });
  await ingestProjectV2Snapshot(remote.raw);
  const libraryId = await ensureLibraryId();
  return applyV2RemoteToStored(project, remote, libraryId);
}

export async function setProjectV2CoverByParasceneId(
  parasceneProjectId: string,
  creationId: string,
): Promise<void> {
  const id = parasceneProjectId.trim();
  const cover = creationId.trim();
  if (!id) throw new Error("Project is missing its Parascene id.");
  if (!cover) throw new Error("Cover creation id is required.");
  const remote = await patchProjectV2(id, { cover });
  await ingestProjectV2Snapshot(remote.raw);
}

export function findStoredProjectForV2Ref(
  projects: readonly StoredProject[],
  ref: string,
): StoredProject | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const direct = projects.find((project) => project.id === trimmed);
  if (direct) return direct;
  const byPara = projects.find(
    (project) => project.parasceneProjectId?.trim() === trimmed,
  );
  if (byPara) return byPara;
  const fromFolder = parasceneIdFromV2FolderId(trimmed);
  if (!fromFolder) return null;
  return (
    projects.find((project) => project.parasceneProjectId?.trim() === fromFolder) ??
    null
  );
}

export function newLocalV2Document(
  remote: ProjectV2Remote,
  libraryId: string,
): StoredProject {
  return applyV2RemoteToStored(
    createStoredProject(
      remote.title || "Untitled project",
      assetIdsFromProjectV2Items(remote.items, libraryId),
    ),
    remote,
    libraryId,
  );
}

export function syntheticFolderFromStoredV2(
  project: StoredProject,
  catalog?: Pick<Creation, "remoteJson"> | null,
): LibraryFolder | null {
  const para = project.parasceneProjectId?.trim();
  if (!isStoredProjectV2(project) || !para) return null;
  const items = catalog ? projectV2ItemsFromCreation(catalog) : [];
  const cover =
    coverAssetIdFromV2Items(items, "", { flaggedOnly: true }) ||
    project.coverCreationId?.trim() ||
    project.creationIds.find((id) => isParasceneCreationId(id)) ||
    null;
  return {
    id: v2FolderId(para),
    title: project.title.trim() || "Untitled project",
    description: "",
    createdAt: project.updatedAt,
    updatedAt: project.updatedAt,
    memberIds: [...project.creationIds],
    memberCount: project.creationIds.length,
    kind: "project",
    projectId: project.id,
    coverCreationId: cover,
    containerVersion: "v2",
    parasceneProjectId: para,
  };
}

export function syntheticFolderFromCatalogV2(
  creation: Pick<
    Creation,
    "id" | "title" | "filename" | "remoteJson" | "createdAt" | "updatedAt"
  >,
): LibraryFolder | null {
  if (!isProjectV2Creation(creation)) return null;
  let parsed = null;
  if (creation.remoteJson) {
    try {
      parsed = parseProjectV2Remote(JSON.parse(creation.remoteJson));
    } catch {
      parsed = null;
    }
  }
  const items = projectV2ItemsFromCreation(creation);
  const coverId = coverAssetIdFromV2Items(items, "");
  return {
    id: v2FolderId(creation.id),
    title:
      parsed?.title.trim() ||
      creation.title.trim() ||
      "Untitled project",
    description: "",
    createdAt: creation.createdAt,
    updatedAt: creation.updatedAt,
    memberIds: items
      .filter((item) => item.pointer.kind === "creation")
      .map((item) =>
        item.pointer.kind === "creation" ? item.pointer.creationId : "",
      )
      .filter(Boolean),
    memberCount: items.length,
    kind: "project",
    projectId: null,
    coverCreationId: coverId,
    containerVersion: "v2",
    parasceneProjectId: creation.id,
  };
}

export function mergeV2ProjectFolders(opts: {
  folders: readonly LibraryFolder[];
  storedProjects: readonly StoredProject[];
  creations?: ReadonlyArray<
    Pick<
      Creation,
      "id" | "title" | "filename" | "remoteJson" | "createdAt" | "updatedAt"
    >
  >;
}): LibraryFolder[] {
  const out: LibraryFolder[] = [];
  const seenPara = new Set<string>();
  const remember = (folder: LibraryFolder) => {
    const para =
      folder.parasceneProjectId?.trim() ||
      parasceneIdFromV2FolderId(folder.id);
    if (para) {
      if (seenPara.has(para)) return;
      seenPara.add(para);
    }
    out.push(folder);
  };
  const catalogById = new Map(
    (opts.creations ?? []).map((creation) => [creation.id, creation]),
  );
  for (const folder of opts.folders) remember(folder);
  for (const project of opts.storedProjects) {
    const para = project.parasceneProjectId?.trim();
    const tile = syntheticFolderFromStoredV2(
      project,
      para ? catalogById.get(para) ?? null : null,
    );
    if (tile) remember(tile);
  }
  for (const creation of opts.creations ?? []) {
    const tile = syntheticFolderFromCatalogV2(creation);
    if (tile) remember(tile);
  }
  return out;
}

export function localOutputIdsToAppend(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id) || isParasceneCreationId(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
