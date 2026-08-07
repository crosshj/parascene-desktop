/**
 * Project Images/Videos cabinets: the backing project folder keeps the cover
 * id. Assets UI flattens members for display only — members must not be filed
 * into the project folder just to show or select them.
 */

import { groupSourceCreationIds } from "../../library/creationFlags";
import type { Creation } from "../../library/types";

/** Member ids that Assets may show/select under cabinet covers. */
export function collectCabinetDisplayMemberIds(
  covers: readonly Creation[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cover of covers) {
    for (const mid of groupSourceCreationIds(cover)) {
      const id = mid.trim();
      if (!id || id === cover.id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Ids that may stay selected without being project.assets / folder members:
 * owned assets plus display-expanded cabinet members.
 */
export function aliveAssetIdsForSelection(
  projectAssetIds: readonly string[],
  cabinetDisplayMemberIds: readonly string[],
): Set<string> {
  const alive = new Set(
    projectAssetIds.map((id) => id.trim()).filter(Boolean),
  );
  for (const id of cabinetDisplayMemberIds) {
    const next = id.trim();
    if (next) alive.add(next);
  }
  return alive;
}
