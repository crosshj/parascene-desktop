/**
 * Assets pane: the current Images/Videos cabinets expand to members and never
 * appear as tiles. A leftover cabinet from an earlier generate is hidden — it
 * must not dump a second video (or a broken stub) into the grid. Ordinary
 * groups stay as covers.
 */

import { groupSourceCreationIds } from "../../library/creationFlags";
import type { Creation } from "../../library/types";
import {
  identifyDesktopCabinet,
  isProjectCabinetId,
  isProjectContainerCoverForDisplay,
  type ProjectCabinetIds,
} from "../../project/desktopProjectGroups";
import type { ProjectAsset } from "../../project/types";

function kindFromCreation(
  creation: Creation | undefined,
  fallback: ProjectAsset["kind"],
): ProjectAsset["kind"] {
  const mt = String(creation?.mediaType ?? fallback).trim().toLowerCase();
  if (mt === "video" || mt === "audio" || mt === "image") return mt;
  return fallback;
}

export type FlattenProjectAssetsForDisplayOpts = {
  projectId: string;
  projectTitle?: string | null;
  rootAssets: readonly ProjectAsset[];
  creationsById: Readonly<Record<string, Creation | undefined>>;
  projectCabinets: ProjectCabinetIds | null | undefined;
};

function cabinetPointerForRole(
  role: "project_images" | "project_videos",
  cabinets: ProjectCabinetIds | null | undefined,
): string {
  if (role === "project_videos") {
    return String(cabinets?.videosGroupId ?? "").trim();
  }
  return String(cabinets?.imagesGroupId ?? "").trim();
}

function isCurrentCabinetCover(
  id: string,
  opts: FlattenProjectAssetsForDisplayOpts,
): boolean {
  return isProjectCabinetId(id, opts.projectCabinets);
}

/** Stale Images/Videos cover after a second generate — hide, do not expand. */
function isLeftoverDesktopCabinet(
  creation: Creation | undefined,
  opts: FlattenProjectAssetsForDisplayOpts,
): boolean {
  const identity = identifyDesktopCabinet(creation);
  if (!identity) return false;
  if (!cabinetPointerForRole(identity.role, opts.projectCabinets)) return false;
  return isProjectContainerCoverForDisplay(creation, {
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
  });
}

function shouldExpandAsCabinet(
  id: string,
  creation: Creation | undefined,
  opts: FlattenProjectAssetsForDisplayOpts,
): boolean {
  if (isCurrentCabinetCover(id, opts)) return true;
  if (isLeftoverDesktopCabinet(creation, opts)) return false;
  return isProjectContainerCoverForDisplay(creation, {
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
  });
}

/** Flat list for the Assets grid: expand project containers, group covers otherwise. */
export function flattenProjectAssetsForBrowserDisplay(
  opts: FlattenProjectAssetsForDisplayOpts,
): ProjectAsset[] {
  const out: ProjectAsset[] = [];
  const seen = new Set<string>();
  const assetById = new Map(opts.rootAssets.map((asset) => [asset.id, asset]));

  const pushId = (id: string, fallbackKind: ProjectAsset["kind"]) => {
    if (seen.has(id)) return;
    seen.add(id);
    const creation = opts.creationsById[id];
    const existing = assetById.get(id);
    out.push({
      id,
      name: existing?.name ?? id,
      kind: kindFromCreation(creation, existing?.kind ?? fallbackKind),
      durationLabel: existing?.durationLabel,
    });
  };

  for (const asset of opts.rootAssets) {
    const creation = opts.creationsById[asset.id];
    if (isLeftoverDesktopCabinet(creation, opts) && !isCurrentCabinetCover(asset.id, opts)) {
      continue;
    }
    if (shouldExpandAsCabinet(asset.id, creation, opts)) {
      const identity = identifyDesktopCabinet(creation);
      const cabinetKind =
        asset.id === opts.projectCabinets?.videosGroupId ||
        identity?.role === "project_videos"
          ? "video"
          : "image";
      for (const mid of creation ? groupSourceCreationIds(creation) : []) {
        pushId(mid, cabinetKind);
      }
      continue;
    }
    pushId(asset.id, asset.kind);
  }

  return out;
}

/** Cover ids in the project asset list whose members must be loaded for expansion. */
export function projectContainerCoverIdsForMemberLoad(
  opts: FlattenProjectAssetsForDisplayOpts,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | null | undefined) => {
    const key = id?.trim() ?? "";
    if (!key || seen.has(key)) return;
    seen.add(key);
    ids.push(key);
  };
  add(opts.projectCabinets?.imagesGroupId);
  add(opts.projectCabinets?.videosGroupId);
  for (const asset of opts.rootAssets) {
    const creation = opts.creationsById[asset.id];
    if (isLeftoverDesktopCabinet(creation, opts) && !isCurrentCabinetCover(asset.id, opts)) {
      continue;
    }
    if (shouldExpandAsCabinet(asset.id, creation, opts)) {
      add(asset.id);
    }
  }
  return ids;
}
