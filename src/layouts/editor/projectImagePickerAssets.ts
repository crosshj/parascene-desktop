/**
 * Image assets for generate pickers — matches Assets-pane cabinet flattening.
 */

import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  applyManifest,
  getCreations,
} from "../../library/catalogClient";
import {
  groupEmbeddedSourceCreations,
  groupSourceCreationIds,
} from "../../library/creationFlags";
import type { Creation } from "../../library/types";
import { type ProjectCabinetIds } from "../../project/desktopProjectGroups";
import type { ProjectAsset } from "../../project/types";
import {
  flattenProjectAssetsForBrowserDisplay,
  projectContainerCoverIdsForMemberLoad,
} from "./assetBrowserDisplay";
import { mapGroupSourceCreations } from "../../sync/manifestSync";

export type ProjectImagePickerContext = {
  projectId: string;
  projectTitle: string;
  projectCabinets: ProjectCabinetIds | null | undefined;
};

export type ProjectPickerAssetKind = ProjectAsset["kind"];

/** Flatten project assets (including cabinet members), optionally by kind. */
export function projectPickerAssets(
  assets: readonly ProjectAsset[],
  creationsById: Readonly<Record<string, Creation | undefined>>,
  context: ProjectImagePickerContext,
  kinds?: readonly ProjectPickerAssetKind[],
): ProjectAsset[] {
  const flat = flattenProjectAssetsForBrowserDisplay({
    projectId: context.projectId,
    projectTitle: context.projectTitle,
    rootAssets: assets,
    creationsById,
    projectCabinets: context.projectCabinets,
  });
  if (!kinds?.length) return flat;
  const allow = new Set(kinds);
  return flat.filter((asset) => allow.has(asset.kind));
}

/** Flatten project assets (including cabinet members) to image stills only. */
export function projectImagePickerAssets(
  assets: readonly ProjectAsset[],
  creationsById: Readonly<Record<string, Creation | undefined>>,
  context: ProjectImagePickerContext,
): ProjectAsset[] {
  return projectPickerAssets(assets, creationsById, context, ["image"]);
}

async function loadProjectAssetCreations(
  assetIds: readonly string[],
  context: ProjectImagePickerContext,
): Promise<Record<string, Creation>> {
  const ids = [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return {};

  const rows = await getCreations(ids);
  const next: Record<string, Creation> = {};
  for (const row of rows) next[row.id] = row;

  const memberIds = new Set<string>();
  const cabinetCovers: Creation[] = [];
  const coverIds = projectContainerCoverIdsForMemberLoad({
    projectId: context.projectId,
    projectTitle: context.projectTitle,
    rootAssets: ids.map((id) => ({ id, name: id, kind: "image" })),
    creationsById: next,
    projectCabinets: context.projectCabinets,
  });
  const missingCoverIds = coverIds.filter((id) => !next[id]);
  if (missingCoverIds.length > 0) {
    const extra = await getCreations(missingCoverIds);
    for (const row of extra) next[row.id] = row;
  }
  for (const coverId of coverIds) {
    const row = next[coverId];
    if (!row) continue;
    cabinetCovers.push(row);
    for (const memberId of groupSourceCreationIds(row)) {
      if (!next[memberId]) memberIds.add(memberId);
    }
  }

  if (memberIds.size > 0) {
    let members = await getCreations([...memberIds]);
    const found = new Set(members.map((row) => row.id));
    const missing = [...memberIds].filter((id) => !found.has(id));
    if (missing.length > 0) {
      const missingSet = new Set(missing);
      const upserts = cabinetCovers.flatMap((cover) =>
        mapGroupSourceCreations(groupEmbeddedSourceCreations(cover)).filter(
          (row) => missingSet.has(row.id),
        ),
      );
      if (upserts.length > 0) {
        await applyManifest(upserts);
        members = await getCreations([...memberIds]);
      }
    }
    for (const row of members) next[row.id] = row;
  }

  return next;
}

export function useProjectPickerAssets(
  assets: readonly ProjectAsset[],
  context: ProjectImagePickerContext,
  kinds?: readonly ProjectPickerAssetKind[],
): ProjectAsset[] {
  const assetIdsKey = useMemo(
    () => assets.map((asset) => asset.id).join("\0"),
    [assets],
  );
  const kindsKey = (kinds ?? []).join(",");
  const [creationsById, setCreationsById] = useState<
    Record<string, Creation>
  >({});

  useEffect(() => {
    const ids = assetIdsKey ? assetIdsKey.split("\0") : [];
    if (ids.length === 0) {
      return;
    }

    let cancelled = false;
    void loadProjectAssetCreations(ids, context)
      .then((next) => {
        if (!cancelled) setCreationsById(next);
      })
      .catch(() => {
        if (!cancelled) setCreationsById({});
      });

    let unlisten: (() => void) | undefined;
    void listen<Creation>("library-creation-updated", (event) => {
      const row = event.payload;
      setCreationsById((prev) => {
        if (prev[row.id] || ids.includes(row.id)) {
          return { ...prev, [row.id]: row };
        }
        return prev;
      });
    }).then((off) => {
      unlisten = off;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [assetIdsKey, context]);

  return useMemo(() => {
    const resolvedCreationsById = assetIdsKey ? creationsById : {};
    return projectPickerAssets(
      assets,
      resolvedCreationsById,
      context,
      kindsKey ? (kindsKey.split(",") as ProjectPickerAssetKind[]) : undefined,
    );
  }, [assetIdsKey, assets, context, creationsById, kindsKey]);
}

export function useProjectImagePickerAssets(
  assets: readonly ProjectAsset[],
  context: ProjectImagePickerContext,
): ProjectAsset[] {
  return useProjectPickerAssets(assets, context, ["image"]);
}
