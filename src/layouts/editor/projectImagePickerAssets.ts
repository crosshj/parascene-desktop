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
import {
  isEditorProjectCabinet,
  type ProjectCabinetIds,
} from "../../project/desktopProjectGroups";
import type { ProjectAsset } from "../../project/types";
import { mapGroupSourceCreations } from "../../sync/manifestSync";

function kindFromCreation(
  creation: Creation | undefined,
  fallback: ProjectAsset["kind"],
): ProjectAsset["kind"] {
  const mt = String(creation?.mediaType ?? fallback)
    .trim()
    .toLowerCase();
  if (mt === "video" || mt === "audio" || mt === "image") return mt;
  return fallback;
}

/** Flatten project assets (including cabinet members) to image stills only. */
export function projectImagePickerAssets(
  assets: readonly ProjectAsset[],
  creationsById: Readonly<Record<string, Creation | undefined>>,
  projectCabinets: ProjectCabinetIds | null | undefined,
): ProjectAsset[] {
  const out: ProjectAsset[] = [];
  const seen = new Set<string>();

  const pushId = (id: string, fallbackKind: ProjectAsset["kind"]) => {
    if (seen.has(id)) return;
    const creation = creationsById[id];
    const kind = kindFromCreation(creation, fallbackKind);
    if (kind !== "image") return;
    seen.add(id);
    const existing = assets.find((asset) => asset.id === id);
    out.push({
      id,
      name: existing?.name ?? id,
      kind: "image",
      durationLabel: existing?.durationLabel,
    });
  };

  for (const asset of assets) {
    const creation = creationsById[asset.id];
    if (isEditorProjectCabinet(asset.id, creation, projectCabinets)) {
      if (asset.id === projectCabinets?.videosGroupId) continue;
      const memberIds = creation ? groupSourceCreationIds(creation) : [];
      for (const memberId of memberIds) {
        pushId(memberId, "image");
      }
      continue;
    }
    pushId(asset.id, asset.kind);
  }

  return out;
}

async function loadProjectAssetCreations(
  assetIds: readonly string[],
  projectCabinets: ProjectCabinetIds | null | undefined,
): Promise<Record<string, Creation>> {
  const ids = [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return {};

  const rows = await getCreations(ids);
  const next: Record<string, Creation> = {};
  for (const row of rows) next[row.id] = row;

  const memberIds = new Set<string>();
  const cabinetCovers: Creation[] = [];
  for (const row of rows) {
    if (!isEditorProjectCabinet(row.id, row, projectCabinets)) continue;
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

export function useProjectImagePickerAssets(
  assets: readonly ProjectAsset[],
  projectCabinets: ProjectCabinetIds | null | undefined,
): ProjectAsset[] {
  const assetIdsKey = useMemo(
    () => assets.map((asset) => asset.id).join("\0"),
    [assets],
  );
  const [creationsById, setCreationsById] = useState<
    Record<string, Creation>
  >({});

  useEffect(() => {
    const ids = assetIdsKey ? assetIdsKey.split("\0") : [];
    if (ids.length === 0) {
      return;
    }

    let cancelled = false;
    void loadProjectAssetCreations(ids, projectCabinets)
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
  }, [assetIdsKey, projectCabinets]);

  return useMemo(() => {
    const resolvedCreationsById = assetIdsKey ? creationsById : {};
    return projectImagePickerAssets(
      assets,
      resolvedCreationsById,
      projectCabinets,
    );
  }, [assetIdsKey, assets, creationsById, projectCabinets]);
}
