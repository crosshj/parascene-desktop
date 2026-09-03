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
import { creationPreviewUrl } from "../../library/previewUrl";
import type { Creation } from "../../library/types";
import { type ProjectCabinetIds } from "../../project/desktopProjectGroups";
import type { ProjectAsset } from "../../project/types";
import {
  flattenProjectAssetsForBrowserDisplay,
  projectContainerCoverIdsForMemberLoad,
} from "./assetBrowserDisplay";
import {
  bumpEditorWorkCounter,
  bumpEditorWorkGauge,
} from "./editorWorkCounters";
import { mapGroupSourceCreations } from "../../sync/manifestSync";

export type ProjectImagePickerContext = {
  projectId: string;
  projectTitle: string;
  projectCabinets: ProjectCabinetIds | null | undefined;
};

export type ProjectPickerAssetKind = ProjectAsset["kind"];

export type ProjectPickerCatalog = {
  assets: ProjectAsset[];
  previews: Record<string, string | null>;
};

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

export function creationPickerFingerprint(row: Creation): string {
  return [
    row.id,
    row.updatedAt,
    String(row.downloadState),
    String(row.mediaType),
    row.localPath ?? "",
    row.localThumbPath ?? "",
    row.fitThumbnailUrl ?? "",
    row.thumbnailUrl ?? "",
    row.remoteJson ?? "",
  ].join("\0");
}

export function creationsByIdUnchanged(
  prev: Readonly<Record<string, Creation>>,
  next: Readonly<Record<string, Creation>>,
): boolean {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return false;
  for (const id of nextKeys) {
    const a = prev[id];
    const b = next[id];
    if (!a || !b) return false;
    if (creationPickerFingerprint(a) !== creationPickerFingerprint(b)) {
      return false;
    }
  }
  return true;
}

export function pickerAssetsFingerprint(
  assets: readonly ProjectAsset[],
): string {
  return assets
    .map(
      (asset) =>
        `${asset.id}\0${asset.kind}\0${asset.name}\0${asset.durationLabel ?? ""}`,
    )
    .join("|");
}

export function pickerPreviewsFingerprint(
  previews: Readonly<Record<string, string | null>>,
): string {
  return Object.keys(previews)
    .sort()
    .map((id) => `${id}\0${previews[id] ?? ""}`)
    .join("|");
}

/**
 * Call `off()` even when the listen promise resolves after effect cleanup.
 */
export function bindAsyncUnlisten(
  pending: Promise<() => void>,
): () => void {
  let disposed = false;
  let off: (() => void) | undefined;
  void pending.then((fn) => {
    if (disposed) {
      fn();
      return;
    }
    off = fn;
  });
  return () => {
    disposed = true;
    off?.();
  };
}

async function loadProjectAssetCreations(
  assetIds: readonly string[],
  context: ProjectImagePickerContext,
): Promise<Record<string, Creation>> {
  const ids = [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return {};

  bumpEditorWorkCounter("catalogLoads");
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

export function useProjectPickerCatalog(
  assets: readonly ProjectAsset[],
  context: ProjectImagePickerContext,
  kinds?: readonly ProjectPickerAssetKind[],
): ProjectPickerCatalog {
  const assetIdsKey = useMemo(
    () => assets.map((asset) => asset.id).join("\0"),
    [assets],
  );
  const kindsKey = (kinds ?? []).join(",");
  const projectId = context.projectId;
  const projectTitle = context.projectTitle;
  const imagesGroupId = context.projectCabinets?.imagesGroupId ?? "";
  const videosGroupId = context.projectCabinets?.videosGroupId ?? "";
  const projectCabinets = useMemo(
    () => ({
      imagesGroupId: imagesGroupId || null,
      videosGroupId: videosGroupId || null,
    }),
    [imagesGroupId, videosGroupId],
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
    const loadContext: ProjectImagePickerContext = {
      projectId,
      projectTitle,
      projectCabinets: {
        imagesGroupId: imagesGroupId || null,
        videosGroupId: videosGroupId || null,
      },
    };
    void loadProjectAssetCreations(ids, loadContext)
      .then((next) => {
        if (cancelled) return;
        setCreationsById((prev) =>
          creationsByIdUnchanged(prev, next) ? prev : next,
        );
      })
      .catch(() => {
        if (cancelled) return;
        setCreationsById((prev) =>
          Object.keys(prev).length === 0 ? prev : {},
        );
      });

    const stop = bindAsyncUnlisten(
      listen<Creation>("library-creation-updated", (event) => {
        const row = event.payload;
        setCreationsById((prev) => {
          if (!(prev[row.id] || ids.includes(row.id))) return prev;
          const next = { ...prev, [row.id]: row };
          return creationsByIdUnchanged(prev, next) ? prev : next;
        });
      }).then((off) => {
        bumpEditorWorkGauge("libraryListeners", 1);
        return () => {
          bumpEditorWorkGauge("libraryListeners", -1);
          off();
        };
      }),
    );

    return () => {
      cancelled = true;
      stop();
    };
  }, [assetIdsKey, projectId, projectTitle, imagesGroupId, videosGroupId]);

  const catalogAssets = useMemo(() => {
    const resolvedCreationsById = assetIdsKey ? creationsById : {};
    return projectPickerAssets(
      assets,
      resolvedCreationsById,
      {
        projectId,
        projectTitle,
        projectCabinets,
      },
      kindsKey ? (kindsKey.split(",") as ProjectPickerAssetKind[]) : undefined,
    );
  }, [
    assetIdsKey,
    creationsById,
    kindsKey,
    projectId,
    projectTitle,
    projectCabinets,
    assets,
  ]);

  const catalogPreviews = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const asset of catalogAssets) {
      const row = creationsById[asset.id];
      if (!row) continue;
      out[asset.id] = creationPreviewUrl(row);
    }
    return out;
  }, [catalogAssets, creationsById]);

  return { assets: catalogAssets, previews: catalogPreviews };
}

export function useProjectPickerAssets(
  assets: readonly ProjectAsset[],
  context: ProjectImagePickerContext,
  kinds?: readonly ProjectPickerAssetKind[],
): ProjectAsset[] {
  return useProjectPickerCatalog(assets, context, kinds).assets;
}

export function useProjectImagePickerAssets(
  assets: readonly ProjectAsset[],
  context: ProjectImagePickerContext,
): ProjectAsset[] {
  return useProjectPickerAssets(assets, context, ["image"]);
}
