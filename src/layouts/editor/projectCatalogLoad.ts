/**
 * Load catalog rows for the Editor Assets pane — cabinet covers, embedded group
 * members, and ordinary project assets.
 */
import {
  applyManifest,
  ensureCatalogCreation,
  getCreations,
  getCreationsHydrated,
} from "../../library/catalogClient";
import type { Creation } from "../../library/types";
import {
  groupEmbeddedSourceCreations,
  groupSourceCreationIds,
} from "../../library/creationFlags";
import { refreshCreationsFromListById } from "../../services/syncCatalog";
import {
  mapGroupSourceCreations,
  syncGroupMembersManifest,
} from "../../sync/manifestSync";
import {
  projectContainerCoverIdsForMemberLoad,
  type FlattenProjectAssetsForDisplayOpts,
} from "./assetBrowserDisplay";

export type LoadProjectAssetsCatalogOpts = FlattenProjectAssetsForDisplayOpts & {
  rootAssetIds: readonly string[];
};

async function refreshProjectCabinetCovers(
  projectCabinets: FlattenProjectAssetsForDisplayOpts["projectCabinets"],
): Promise<void> {
  const coverIds = [projectCabinets?.imagesGroupId, projectCabinets?.videosGroupId]
    .map((id) => (id ? String(id).trim() : ""))
    .filter(Boolean);
  if (coverIds.length === 0) return;
  try {
    // List pages carry meta.group; detail GET often omits membership.
    await refreshCreationsFromListById(coverIds);
  } catch (error) {
    console.warn("Could not refresh project cabinet covers from list", error);
  }
}

async function hydrateGroupCovers(coverIds: readonly string[]): Promise<void> {
  await Promise.all(
    coverIds.map((id) =>
      ensureCatalogCreation(id).catch((error) => {
        console.warn(`Could not hydrate group cover ${id}`, error);
      }),
    ),
  );
}

async function materializeMissingMembersFromCovers(
  next: Record<string, Creation>,
  coverIds: readonly string[],
): Promise<void> {
  const memberIds = new Set<string>();
  const cabinetCovers: Creation[] = [];
  for (const coverId of coverIds) {
    const row = next[coverId];
    if (!row) continue;
    cabinetCovers.push(row);
    for (const mid of groupSourceCreationIds(row)) {
      if (!next[mid]) memberIds.add(mid);
    }
  }
  if (memberIds.size === 0) return;

  let members = await getCreationsHydrated([...memberIds], coverIds);
  const found = new Set(members.map((row) => row.id));
  const missing = [...memberIds].filter((id) => !found.has(id));
  if (missing.length === 0) {
    for (const row of members) next[row.id] = row;
    return;
  }

  const missingSet = new Set(missing);
  const upserts = cabinetCovers.flatMap((cover) =>
    mapGroupSourceCreations(groupEmbeddedSourceCreations(cover)).filter((row) =>
      missingSet.has(row.id),
    ),
  );
  if (upserts.length > 0) {
    await applyManifest(upserts);
    members = await getCreations([...memberIds]);
  }
  for (const row of members) next[row.id] = row;
}

/** Catalog map for Assets / preview — heals pruned cabinet members on reopen. */
export async function loadProjectAssetsCatalog(
  opts: LoadProjectAssetsCatalogOpts,
): Promise<Record<string, Creation>> {
  const coverIds = projectContainerCoverIdsForMemberLoad(opts);

  await refreshProjectCabinetCovers(opts.projectCabinets);
  await hydrateGroupCovers(coverIds);
  await syncGroupMembersManifest().catch((error) => {
    console.warn("Could not sync embedded group members", error);
  });

  const seedIds = [...new Set([...opts.rootAssetIds, ...coverIds])];
  const rows = await getCreationsHydrated(seedIds, coverIds);
  const next: Record<string, Creation> = {};
  for (const row of rows) next[row.id] = row;

  await materializeMissingMembersFromCovers(next, coverIds);
  return next;
}
