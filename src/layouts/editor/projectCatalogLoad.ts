/**
 * Load catalog rows for the Editor Assets pane — cabinet covers, embedded group
 * members, and ordinary project assets.
 *
 * Local SQLite + on-disk files only. Missing members come from group-cover JSON
 * already in the catalog. Do not call Parascene from Assets.
 */
import {
  applyManifest,
  getCreations,
} from "../../library/catalogClient";
import type { Creation } from "../../library/types";
import {
  groupEmbeddedSourceCreations,
  groupSourceCreationIds,
} from "../../library/creationFlags";
import { mapGroupSourceCreations } from "../../sync/manifestSync";
import {
  projectContainerCoverIdsForMemberLoad,
  type FlattenProjectAssetsForDisplayOpts,
} from "./assetBrowserDisplay";

export type LoadProjectAssetsCatalogOpts = FlattenProjectAssetsForDisplayOpts & {
  rootAssetIds: readonly string[];
};

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

  let members = await getCreations([...memberIds]);
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

/** Catalog map for Assets / preview — local catalog only. */
export async function loadProjectAssetsCatalog(
  opts: LoadProjectAssetsCatalogOpts,
): Promise<Record<string, Creation>> {
  const coverIds = projectContainerCoverIdsForMemberLoad(opts);
  const seedIds = [...new Set([...opts.rootAssetIds, ...coverIds])];
  const rows = await getCreations(seedIds);
  const next: Record<string, Creation> = {};
  for (const row of rows) next[row.id] = row;

  await materializeMissingMembersFromCovers(next, coverIds);
  return next;
}
