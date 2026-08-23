import { listen } from "@tauri-apps/api/event";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { creationAspectCss } from "../../library/aspectRatio";
import {
  applyManifest,
  ensureLocal,
  getCreations,
} from "../../library/catalogClient";
import { CreationCard } from "../../library/CreationCard";
import {
  creationCardTitle,
  groupEmbeddedSourceCreations,
  groupSourceCreationIds,
} from "../../library/creationFlags";
import { isLocalOnlyCreation } from "../../library/creationFilters";
import { FolderCard } from "../../library/FolderCard";
import CompositionCard from "../../library/CompositionCard";
import type { LibraryFolder } from "../../library/folderClient";
import {
  canFetchLocal,
  creationDetailUrl,
  creationPreviewUrl,
} from "../../library/previewUrl";
import type { Creation, MediaType } from "../../library/types";
import {
  isEditorProjectCabinet,
  type ProjectCabinetIds,
} from "../../project/desktopProjectGroups";
import {
  projectAspectCss,
  type ProjectAspectRatio,
} from "../../project/aspectRatios";
import type { LibraryAssetPlaceholder } from "../../project/libraryAssetPlaceholder";
import { isActiveLibraryAssetPlaceholder } from "../../project/libraryAssetPlaceholder";
import type { ProjectAsset } from "../../project/types";
import {
  compositionInternalCreationIds,
  compositionOutsideMemberIds,
  type StillWorkstream,
} from "../../project/stillWorkstream";
import { mapGroupSourceCreations } from "../../sync/manifestSync";
export type AssetKindFilter = "all" | MediaType;

const FILTERS: { id: AssetKindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Video" },
  { id: "image", label: "Image" },
  { id: "audio", label: "Audio" },
];

type AssetBrowserPaneProps = {
  assets: ProjectAsset[];
  folders?: LibraryFolder[];
  /** Desktop Images cabinet id — expand members; hide cover. */
  imagesGroupId?: string | null;
  /** Desktop Videos cabinet id — expand members; hide cover. */
  videosGroupId?: string | null;
  filter: AssetKindFilter;
  selectedId: string | null;
  selectedIds: readonly string[];
  onFilterChange: (filter: AssetKindFilter) => void;
  onSelectionChange: (ids: string[], primaryId: string | null) => void;
  onCollapse: () => void;
  /** True when shown as a narrow-desktop drawer overlay. */
  drawer?: boolean;
  /** True when a selected asset owns the preview. */
  previewActive?: boolean;
  /** Project creative frame — used for the add-asset slot card. */
  aspectRatio: ProjectAspectRatio;
  /** In-flight Generate → Assets placeholders keyed by asset id. */
  libraryAssetPlaceholders?: Record<string, LibraryAssetPlaceholder>;
  /** True when the add-asset slot owns the preview. */
  addSlotSelected?: boolean;
  onAddSlotSelect?: () => void;
  onDeleteAssets?: (ids: string[]) => void;
  onRemoveAssets?: (ids: string[]) => void;
  onDiscardLibraryAssetPlaceholders?: (ids: string[]) => void;
  onDeleteFromGroup?: (opts: {
    groupId: string;
    kind: "images" | "videos";
    memberIds: string[];
  }) => void;
  /** Asset ids referenced on the project timeline (blocks group delete). */
  timelineUsedAssetIds?: ReadonlySet<string>;
  /** Still compositions (sandbox / record / group). */
  compositions?: readonly StillWorkstream[];
  openCompositionId?: string | null;
  onOpenComposition?: (composition: StillWorkstream) => void;
  onDeleteCompositions?: (compositionIds: string[]) => void;
  /** Creation ids referenced by the project but not in the project folder. */
  outsideReferenceIds?: readonly string[];
  onAddOutsideToProject?: (creationId: string) => void;
};

type AssetContextMenu =
  | { kind: "assets"; assetIds: string[]; x: number; y: number }
  | { kind: "folders"; folderIds: string[]; x: number; y: number }
  | { kind: "compositions"; compositionIds: string[]; x: number; y: number }
  | { kind: "outside"; assetIds: string[]; x: number; y: number };

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

function displayName(
  asset: ProjectAsset,
  creation: Creation | undefined,
): string {
  if (creation) {
    const titled = creationCardTitle(creation);
    if (!titled.untitled) return titled.text;
    const filename = creation.filename?.trim();
    if (filename) return filename;
  }
  return asset.name;
}

/** Default slot for adding assets — project aspect, outline with plus. */
function AddAssetSlotCard({
  aspectCss,
  selected,
  onSelect,
}: {
  aspectCss: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="editor-add-asset-card">
      <button
        type="button"
        className={
          selected
            ? "editor-add-asset-card-hit is-selected"
            : "editor-add-asset-card-hit"
        }
        onClick={onSelect}
        aria-label="Add asset"
        title="Add asset"
      >
        <span
          className="editor-add-asset-card-clip"
          style={{ aspectRatio: aspectCss }}
          aria-hidden
        >
          <svg
            className="editor-add-asset-card-icon"
            viewBox="0 0 24 24"
            width="28"
            height="28"
            aria-hidden
          >
            <path
              d="M12 5v14M5 12h14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </span>
      </button>
    </div>
  );
}

/** Generating library asset — project aspect outline while media is pending. */
function PlaceholderAssetTile({
  placeholder,
  previewCreation = null,
  selected,
  onSelect,
  onContextMenu,
}: {
  placeholder: LibraryAssetPlaceholder;
  previewCreation?: Creation | null;
  selected: boolean;
  onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const label =
    placeholder.addAssetDraft.prompt?.trim().slice(0, 48) || "Generating…";
  const previewUrl = previewCreation
    ? (creationPreviewUrl(previewCreation) ?? creationDetailUrl(previewCreation))
    : null;
  const generating =
    placeholder.status === "generating" && !previewUrl;
  return (
    <div className="editor-add-asset-card">
      <button
        type="button"
        className={
          selected
            ? "editor-add-asset-card-hit is-selected"
            : "editor-add-asset-card-hit"
        }
        onClick={onSelect}
        onContextMenu={onContextMenu}
        title={label}
        aria-label={label}
      >
        <span
          className={
            generating
              ? "editor-add-asset-card-clip is-generating"
              : "editor-add-asset-card-clip"
          }
          style={{ aspectRatio: projectAspectCss(placeholder.aspectRatio) }}
          aria-hidden
        >
          {previewUrl ? (
            <img
              className="editor-add-asset-card-thumb"
              src={previewUrl}
              alt=""
            />
          ) : (
            <span className="editor-add-asset-card-generating-label">
              {placeholder.status === "error" ? "Error" : "Generating…"}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}

/** Fallback when the id is not in the local catalog yet. */
function StubAssetTile({
  asset,
  selected,
  onSelect,
  onContextMenu,
}: {
  asset: ProjectAsset;
  selected: boolean;
  onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={
        selected ? "editor-asset-tile is-selected" : "editor-asset-tile"
      }
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={asset.name}
    >
      <span className={`editor-asset-thumb kind-${asset.kind}`} aria-hidden>
        <span className="editor-asset-thumb-label">
          {asset.kind === "video"
            ? "Video"
            : asset.kind === "audio"
              ? "Audio"
              : "Image"}
        </span>
      </span>
      <span className="editor-asset-meta">
        <span className="editor-asset-kind">{asset.kind}</span>
        <span className="editor-asset-name">{asset.name}</span>
      </span>
    </button>
  );
}

export function AssetBrowserPane({
  assets,
  folders = [],
  imagesGroupId = null,
  videosGroupId = null,
  filter,
  selectedId,
  selectedIds,
  onFilterChange,
  onSelectionChange,
  onCollapse,
  drawer = false,
  previewActive = false,
  aspectRatio,
  libraryAssetPlaceholders = {},
  addSlotSelected = false,
  onAddSlotSelect,
  onDeleteAssets,
  onRemoveAssets,
  onDiscardLibraryAssetPlaceholders,
  onDeleteFromGroup,
  timelineUsedAssetIds,
  compositions = [],
  openCompositionId = null,
  onOpenComposition,
  onDeleteCompositions,
  outsideReferenceIds = [],
  onAddOutsideToProject,
}: AssetBrowserPaneProps) {
  const [creationsById, setCreationsById] = useState<
    Record<string, Creation>
  >({});
  const [contextMenu, setContextMenu] = useState<AssetContextMenu | null>(null);
  const [folderViewId, setFolderViewId] = useState<string | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const assetScrollRef = useRef<HTMLDivElement>(null);
  const lastScrolledAssetIdRef = useRef<string | null>(null);

  const projectCabinets = useMemo<ProjectCabinetIds>(
    () => ({ imagesGroupId, videosGroupId }),
    [imagesGroupId, videosGroupId],
  );

  const folderView =
    folders.find((folder) => folder.id === folderViewId) ?? null;

  if (folderViewId && !folders.some((folder) => folder.id === folderViewId)) {
    setFolderViewId(null);
  }

  const filedInProjectFolders = useMemo(() => {
    const ids = new Set<string>();
    for (const folder of folders) {
      for (const memberId of folder.memberIds) ids.add(memberId);
    }
    return ids;
  }, [folders]);

  const compositionHiddenIds = useMemo(
    () => compositionInternalCreationIds(compositions),
    [compositions],
  );

  const rootAssets = useMemo(() => {
    if (folderView) {
      const members = new Set(folderView.memberIds);
      return assets.filter((asset) => members.has(asset.id));
    }
    let rows = assets.filter((asset) => !filedInProjectFolders.has(asset.id));
    // Plate / AI steps stay inside compositions until promoted.
    if (compositionHiddenIds.size > 0) {
      rows = rows.filter((asset) => !compositionHiddenIds.has(asset.id));
    }
    return rows;
  }, [
    assets,
    compositionHiddenIds,
    filedInProjectFolders,
    folderView,
  ]);

  const visibleCompositions = useMemo(() => {
    if (folderView) return [];
    if (filter !== "all" && filter !== "image") return [];
    return [...compositions].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [compositions, filter, folderView]);

  const showRootCompositions =
    !folderView && visibleCompositions.length > 0 && Boolean(onOpenComposition);

  const outsideIdSet = useMemo(
    () => new Set(outsideReferenceIds.map((id) => id.trim()).filter(Boolean)),
    [outsideReferenceIds],
  );

  const extraOutsideIds = useMemo(() => {
    const owned = new Set(rootAssets.map((asset) => asset.id));
    const ids: string[] = [];
    for (const stream of compositions) {
      for (const id of compositionOutsideMemberIds(stream, outsideIdSet)) {
        if (!owned.has(id) && !ids.includes(id)) ids.push(id);
      }
    }
    return ids;
  }, [compositions, outsideIdSet, rootAssets]);

  const placeholderPendingIds = useMemo(() => {
    const ids: string[] = [];
    for (const placeholder of Object.values(libraryAssetPlaceholders)) {
      const pending =
        placeholder.addAssetDraft.generationJob?.pendingCreationId?.trim();
      if (pending && !ids.includes(pending)) ids.push(pending);
    }
    return ids;
  }, [libraryAssetPlaceholders]);

  const assetIdsKey = useMemo(
    () =>
      [
        ...rootAssets.map((a) => a.id),
        ...extraOutsideIds,
        ...placeholderPendingIds,
      ].join("\0"),
    [extraOutsideIds, placeholderPendingIds, rootAssets],
  );

  useEffect(() => {
    if (!contextMenu) return;

    let onPointerDown: ((event: PointerEvent) => void) | null = null;
    let onKey: ((event: KeyboardEvent) => void) | null = null;
    let onScroll: (() => void) | null = null;

    // Defer so the opening right-click doesn't immediately dismiss the menu.
    const timer = window.setTimeout(() => {
      onPointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(".editor-asset-context-menu")
        ) {
          return;
        }
        setContextMenu(null);
      };
      onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") setContextMenu(null);
      };
      onScroll = () => setContextMenu(null);
      window.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", onScroll, true);
    }, 0);

    return () => {
      window.clearTimeout(timer);
      if (onPointerDown) {
        window.removeEventListener("pointerdown", onPointerDown);
      }
      if (onKey) window.removeEventListener("keydown", onKey);
      if (onScroll) window.removeEventListener("scroll", onScroll, true);
    };
  }, [contextMenu]);

  const [menuAssetIdsKey, setMenuAssetIdsKey] = useState(assetIdsKey);
  if (assetIdsKey !== menuAssetIdsKey) {
    setMenuAssetIdsKey(assetIdsKey);
    if (contextMenu) setContextMenu(null);
  }

  if (!assetIdsKey && Object.keys(creationsById).length > 0) {
    setCreationsById({});
  }

  useEffect(() => {
    const ids = assetIdsKey ? assetIdsKey.split("\0") : [];
    if (ids.length === 0) return;

    let cancelled = false;

    const load = async () => {
      try {
        const rows = await getCreations(ids);
        if (cancelled) return;
        const next: Record<string, Creation> = {};
        for (const row of rows) next[row.id] = row;

        // Pull cabinet members so Assets can show them outside the cover.
        // Display flatten only — do not file members into the project folder.
        // Same as Library lightbox: if a member row was pruned/missing, rebuild
        // it from the cover's embedded source_creations so we don't paint stubs.
        const memberIds = new Set<string>();
        const cabinetCovers: Creation[] = [];
        for (const row of rows) {
          if (!isEditorProjectCabinet(row.id, row, projectCabinets)) continue;
          cabinetCovers.push(row);
          for (const mid of groupSourceCreationIds(row)) {
            if (!next[mid]) memberIds.add(mid);
          }
        }
        if (memberIds.size > 0) {
          let members = await getCreations([...memberIds]);
          if (cancelled) return;
          const found = new Set(members.map((row) => row.id));
          const missing = [...memberIds].filter((id) => !found.has(id));
          if (missing.length > 0) {
            const missingSet = new Set(missing);
            const upserts = cabinetCovers.flatMap((cover) =>
              mapGroupSourceCreations(
                groupEmbeddedSourceCreations(cover),
              ).filter((row) => missingSet.has(row.id)),
            );
            if (upserts.length > 0) {
              await applyManifest(upserts);
              if (cancelled) return;
              members = await getCreations([...memberIds]);
            }
          }
          if (cancelled) return;
          for (const row of members) next[row.id] = row;
        }

        setCreationsById(next);

        const needThumbs = Object.values(next)
          .filter((c) => !creationPreviewUrl(c) && canFetchLocal(c))
          .map((c) => c.id);
        if (needThumbs.length > 0) {
          void ensureLocal(needThumbs, { fullMedia: false });
        }
      } catch {
        if (!cancelled) setCreationsById({});
      }
    };

    void load();

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

  /** Flat list for the grid: cabinets expand to members (covers are hidden). */
  const displayAssets = useMemo(() => {
    const out: ProjectAsset[] = [];
    const seen = new Set<string>();

    const pushId = (id: string, fallbackKind: ProjectAsset["kind"]) => {
      if (seen.has(id)) return;
      seen.add(id);
      const creation = creationsById[id];
      const existing = assets.find((a) => a.id === id);
      out.push({
        id,
        name: existing?.name ?? id,
        kind: kindFromCreation(creation, existing?.kind ?? fallbackKind),
        durationLabel: existing?.durationLabel,
      });
    };

    for (const asset of rootAssets) {
      const creation = creationsById[asset.id];
      if (isEditorProjectCabinet(asset.id, creation, projectCabinets)) {
        const memberIds = creation ? groupSourceCreationIds(creation) : [];
        const cabinetKind =
          asset.id === projectCabinets?.videosGroupId ? "video" : "image";
        for (const mid of memberIds) {
          pushId(mid, cabinetKind);
        }
        continue;
      }
      pushId(asset.id, asset.kind);
    }

    return out;
  }, [assets, creationsById, projectCabinets, rootAssets]);

  const visible = displayAssets.filter((asset) => {
    if (filter === "all") return true;
    return kindFromCreation(creationsById[asset.id], asset.kind) === filter;
  });
  const visibleOutsideIds = extraOutsideIds.filter((id) => {
    if (visible.some((asset) => asset.id === id)) return false;
    if (filter !== "all" && filter !== "image") {
      return kindFromCreation(creationsById[id], "image") === filter;
    }
    return true;
  });

  const selectedAssetVisibleKey = useMemo(() => {
    const id = selectedId?.trim();
    if (!id) return null;
    const inGrid =
      visible.some((asset) => asset.id === id) ||
      visibleOutsideIds.includes(id);
    return inGrid ? id : `pending:${id}`;
  }, [selectedId, visible, visibleOutsideIds]);

  useEffect(() => {
    const key = selectedAssetVisibleKey;
    if (!key || key.startsWith("pending:") || key === lastScrolledAssetIdRef.current) {
      return;
    }
    lastScrolledAssetIdRef.current = key;
    const frame = requestAnimationFrame(() => {
      const root = assetScrollRef.current;
      if (!root) return;
      const tile = root.querySelector<HTMLElement>(
        `[data-asset-id="${CSS.escape(key)}"]`,
      );
      tile?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedAssetVisibleKey]);

  const visibleFolders = useMemo(() => {
    if (folderView || folders.length === 0) return [];
    if (filter === "all") return folders;
    return folders.filter((folder) =>
      folder.memberIds.some((id) => {
        const asset = assets.find((row) => row.id === id);
        if (!asset) return false;
        return kindFromCreation(creationsById[id], asset.kind) === filter;
      }),
    );
  }, [assets, creationsById, filter, folderView, folders]);

  const creationsByIdMap = useMemo(() => {
    const map = new Map<string, Creation>();
    for (const [id, creation] of Object.entries(creationsById)) {
      map.set(id, creation);
    }
    return map;
  }, [creationsById]);

  const folderCollageIdsByFolderId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const folder of visibleFolders) {
      const ids =
        filter === "all"
          ? folder.memberIds.slice(0, 4)
          : folder.memberIds.filter((id) => {
              const asset = assets.find((row) => row.id === id);
              if (!asset) return false;
              return kindFromCreation(creationsById[id], asset.kind) === filter;
            });
      map.set(folder.id, ids.slice(0, 4));
    }
    return map;
  }, [assets, creationsById, filter, visibleFolders]);

  const showRootFolders = visibleFolders.length > 0;

  const isLocalOnlyAsset = (assetId: string): boolean => {
    const creation = creationsById[assetId];
    if (!creation) return false;
    // Desktop Generate stamps local rows with remoteJson provenance — still
    // deletable as long as there is no cloud remote_url.
    if (creation.remoteUrl?.trim()) return false;
    return (
      isLocalOnlyCreation(creation) ||
      String(creation.downloadState ?? "").toLowerCase() === "local" ||
      creation.id.startsWith("local-")
    );
  };

  const groupMembershipByMemberId = useMemo(() => {
    const map = new Map<
      string,
      { groupId: string; kind: "images" | "videos" }
    >();
    const cabinets: Array<{
      id: string | null | undefined;
      kind: "images" | "videos";
    }> = [
      { id: imagesGroupId, kind: "images" },
      { id: videosGroupId, kind: "videos" },
    ];
    for (const { id, kind } of cabinets) {
      const groupId = id ? String(id).trim() : "";
      if (!groupId) continue;
      const cover = creationsById[groupId];
      if (!cover) continue;
      for (const memberId of groupSourceCreationIds(cover)) {
        if (memberId === groupId) continue;
        map.set(memberId, { groupId, kind });
      }
    }
    return map;
  }, [creationsById, imagesGroupId, videosGroupId]);

  const groupDeleteTarget = useMemo(() => {
    if (!contextMenu || contextMenu.kind !== "assets" || !onDeleteFromGroup) {
      return null;
    }
    const groupIds = new Set(
      contextMenu.assetIds
        .map((id) => groupMembershipByMemberId.get(id)?.groupId)
        .filter((id): id is string => Boolean(id)),
    );
    if (groupIds.size !== 1) return null;
    const groupId = [...groupIds][0];
    const kind = groupMembershipByMemberId.get(contextMenu.assetIds[0])?.kind;
    if (!kind) return null;
    if (
      !contextMenu.assetIds.every(
        (id) => groupMembershipByMemberId.get(id)?.groupId === groupId,
      )
    ) {
      return null;
    }
    return { groupId, kind, memberIds: contextMenu.assetIds };
  }, [contextMenu, groupMembershipByMemberId, onDeleteFromGroup]);

  const groupDeleteBlocked =
    groupDeleteTarget != null &&
    groupDeleteTarget.memberIds.some((id) =>
      timelineUsedAssetIds?.has(id),
    );

  const contextMenuHasGroupMembers =
    contextMenu?.kind === "assets" &&
    contextMenu.assetIds.some((id) => groupMembershipByMemberId.has(id));

  const contextMenuDiscardablePlaceholderIds = useMemo(() => {
    if (contextMenu?.kind !== "assets") return [];
    return contextMenu.assetIds.filter((id) =>
      isActiveLibraryAssetPlaceholder(libraryAssetPlaceholders[id]),
    );
  }, [contextMenu, libraryAssetPlaceholders]);

  const contextMenuRemovableAssetIds = useMemo(() => {
    if (contextMenu?.kind !== "assets") return [];
    return contextMenu.assetIds.filter(
      (id) => !isActiveLibraryAssetPlaceholder(libraryAssetPlaceholders[id]),
    );
  }, [contextMenu, libraryAssetPlaceholders]);

  const openContextMenu = (
    assetId: string,
    event: ReactMouseEvent,
  ) => {
    const isGroupMember = groupMembershipByMemberId.has(assetId);
    if (
      !onDeleteAssets &&
      !onRemoveAssets &&
      !onDiscardLibraryAssetPlaceholders &&
      !(onDeleteFromGroup && isGroupMember)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const assetIds = selectedIds.includes(assetId) ? [...selectedIds] : [assetId];
    if (!selectedIds.includes(assetId)) {
      selectionAnchorRef.current = assetId;
      onSelectionChange(assetIds, assetId);
    }
    setContextMenu({
      kind: "assets",
      assetIds,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const openFolderContextMenu = (
    _folderId: string,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
  };

  const openCompositionContextMenu = (
    compositionId: string,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (!onDeleteCompositions) return;
    setContextMenu({
      kind: "compositions",
      compositionIds: [compositionId],
      x: event.clientX,
      y: event.clientY,
    });
  };

  const showAddSlot = !folderView && Boolean(onAddSlotSelect);
  const addSlotAspectCss = projectAspectCss(aspectRatio);

  const selectAsset = (assetId: string, event: ReactMouseEvent) => {
    if (event.shiftKey && selectionAnchorRef.current) {
      const ids = visible.map((asset) => asset.id);
      const anchorIndex = ids.indexOf(selectionAnchorRef.current);
      const clickedIndex = ids.indexOf(assetId);
      if (anchorIndex >= 0 && clickedIndex >= 0) {
        const from = Math.min(anchorIndex, clickedIndex);
        const to = Math.max(anchorIndex, clickedIndex);
        onSelectionChange(ids.slice(from, to + 1), assetId);
        return;
      }
    }

    if (event.metaKey || event.ctrlKey) {
      const alreadySelected = selectedIds.includes(assetId);
      const next = alreadySelected
        ? selectedIds.filter((id) => id !== assetId)
        : [...selectedIds, assetId];
      selectionAnchorRef.current = assetId;
      const primaryId = alreadySelected
        ? selectedId && next.includes(selectedId)
          ? selectedId
          : (next[next.length - 1] ?? null)
        : assetId;
      onSelectionChange(next, primaryId);
      return;
    }

    selectionAnchorRef.current = assetId;
    onSelectionChange([assetId], assetId);
  };

  return (
    <aside
      className={[
        drawer ? "editor-asset-pane is-drawer" : "editor-asset-pane",
        previewActive ? "is-preview-active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Assets"
    >
      <div className="editor-pane-head">
        <h2>Assets</h2>
        <button
          type="button"
          className="editor-pane-collapse"
          onClick={onCollapse}
          title={drawer ? "Close assets" : "Collapse assets"}
          aria-label={drawer ? "Close assets" : "Collapse assets"}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path
              fill="currentColor"
              d="M10.5 3.25 5.75 8l4.75 4.75-1.05 1.05L3.65 8l5.8-5.8z"
            />
          </svg>
        </button>
      </div>

      {folderView ? (
        <div className="library-folder-breadcrumb editor-asset-breadcrumb">
          <button
            type="button"
            className="library-folder-home"
            aria-label="Assets home"
            onClick={() => setFolderViewId(null)}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
              <path
                fill="currentColor"
                d="M12 3 3 10h2v9h5v-5h4v5h5v-9h2z"
              />
            </svg>
          </button>
          <span className="library-folder-crumb-sep" aria-hidden>
            ›
          </span>
          <span className="library-folder-crumb-name">{folderView.title}</span>
        </div>
      ) : null}

      <div className="editor-asset-filters" role="toolbar" aria-label="Asset filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={
              filter === f.id
                ? "editor-asset-filter is-active"
                : "editor-asset-filter"
            }
            aria-pressed={filter === f.id}
            onClick={() => onFilterChange(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="editor-asset-scroll" ref={assetScrollRef}>
        {visible.length === 0 &&
        visibleOutsideIds.length === 0 &&
        !showRootFolders &&
        !showRootCompositions &&
        !showAddSlot ? (
          <p className="muted editor-asset-empty">No assets in this filter.</p>
        ) : (
          <ul className="editor-asset-grid">
            {showAddSlot ? (
              <li key="add-asset-slot">
                <AddAssetSlotCard
                  aspectCss={addSlotAspectCss}
                  selected={addSlotSelected}
                  onSelect={() => onAddSlotSelect?.()}
                />
              </li>
            ) : null}
            {showRootCompositions
              ? visibleCompositions.map((composition) => (
                  <li key={`composition:${composition.id}`}>
                    <CompositionCard
                      composition={composition}
                      aspectCss={projectAspectCss(aspectRatio)}
                      selected={openCompositionId === composition.id}
                      outsideCount={
                        compositionOutsideMemberIds(
                          composition,
                          outsideIdSet,
                        ).length
                      }
                      onOpen={(next) => {
                        // Clear ordinary asset selection first. EditorLayout's
                        // selection path closes any open composition, so the
                        // composition open must be the final state change.
                        onSelectionChange([], null);
                        onOpenComposition?.(next);
                      }}
                      onContextMenu={(next, event) =>
                        openCompositionContextMenu(next.id, event)
                      }
                    />
                  </li>
                ))
              : null}
            {showRootFolders
              ? visibleFolders.map((folder) => (
                  <li key={`folder:${folder.id}`}>
                    <FolderCard
                      folder={folder}
                      collageMemberIds={
                        folderCollageIdsByFolderId.get(folder.id) ??
                        folder.memberIds
                      }
                      creationsById={creationsByIdMap}
                      onOpen={(next) => {
                        setFolderViewId(next.id);
                        onSelectionChange([], null);
                      }}
                      onContextMenu={(next, event) =>
                        openFolderContextMenu(next.id, event)
                      }
                    />
                  </li>
                ))
              : null}
            {visible.map((asset) => {
              const creation = creationsById[asset.id];
              const placeholder = libraryAssetPlaceholders[asset.id] ?? null;
              const pendingCreationId =
                placeholder?.addAssetDraft.generationJob?.pendingCreationId?.trim();
              const pendingCreation = pendingCreationId
                ? creationsById[pendingCreationId]
                : null;
              const selected = selectedIds.includes(asset.id);
              return (
                <li key={asset.id} data-asset-id={asset.id}>
                  {placeholder && placeholder.status !== "done" ? (
                    <PlaceholderAssetTile
                      placeholder={placeholder}
                      previewCreation={pendingCreation}
                      selected={selected}
                      onSelect={(event) => selectAsset(asset.id, event)}
                      onContextMenu={(event) =>
                        openContextMenu(asset.id, event)
                      }
                    />
                  ) : creation ? (
                    <CreationCard
                      creation={creation}
                      aspectCss={creationAspectCss(creation)}
                      selected={selected}
                      outsideProject={outsideIdSet.has(asset.id)}
                      onOpen={(row, event) => selectAsset(row.id, event)}
                      onContextMenu={(row, event) =>
                        openContextMenu(row.id, event)
                      }
                    />
                  ) : (
                    <StubAssetTile
                      asset={{
                        ...asset,
                        name: displayName(asset, creation),
                      }}
                      selected={selected}
                      onSelect={(event) => selectAsset(asset.id, event)}
                      onContextMenu={(event) =>
                        openContextMenu(asset.id, event)
                      }
                    />
                  )}
                </li>
              );
            })}
            {visibleOutsideIds.map((id) => {
              const creation = creationsById[id];
              const selected = selectedIds.includes(id);
              return (
                <li key={`outside:${id}`} data-asset-id={id}>
                  {creation ? (
                    <CreationCard
                      creation={creation}
                      aspectCss={creationAspectCss(creation)}
                      selected={selected}
                      outsideProject
                      onOpen={(row, event) => selectAsset(row.id, event)}
                      onContextMenu={(row, event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setContextMenu({
                          kind: "outside",
                          assetIds: [row.id],
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                    />
                  ) : (
                    <StubAssetTile
                      asset={{
                        id,
                        name: id,
                        kind: "image",
                      }}
                      selected={selected}
                      onSelect={(event) => selectAsset(id, event)}
                      onContextMenu={(event) => openContextMenu(id, event)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {contextMenu
        ? createPortal(
            <div
              className="editor-asset-context-menu"
              role="menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              {contextMenu.kind === "compositions" && onDeleteCompositions ? (
                <button
                  type="button"
                  className="editor-asset-context-item is-danger"
                  role="menuitem"
                  onClick={() => {
                    const ids = contextMenu.compositionIds;
                    setContextMenu(null);
                    onDeleteCompositions(ids);
                  }}
                >
                  Delete composition
                  {contextMenu.compositionIds.length > 1
                    ? ` (${contextMenu.compositionIds.length})`
                    : ""}
                </button>
              ) : null}
              {contextMenu.kind === "outside" && onAddOutsideToProject ? (
                <button
                  type="button"
                  className="editor-asset-context-item"
                  role="menuitem"
                  onClick={() => {
                    const id = contextMenu.assetIds[0];
                    setContextMenu(null);
                    if (id) onAddOutsideToProject(id);
                  }}
                >
                  Add to this project
                </button>
              ) : null}
              {contextMenu.kind === "assets" &&
              onDeleteFromGroup &&
              groupDeleteTarget ? (
                <button
                  type="button"
                  className="editor-asset-context-item is-danger"
                  role="menuitem"
                  disabled={groupDeleteBlocked}
                  title={
                    groupDeleteBlocked
                      ? "Remove timeline clips that use these assets first."
                      : undefined
                  }
                  onClick={() => {
                    if (groupDeleteBlocked) return;
                    const target = groupDeleteTarget;
                    setContextMenu(null);
                    onDeleteFromGroup(target);
                  }}
                >
                  Delete from{" "}
                  {groupDeleteTarget.kind === "images" ? "Images" : "Videos"}{" "}
                  group
                  {groupDeleteTarget.memberIds.length > 1
                    ? ` (${groupDeleteTarget.memberIds.length})`
                    : ""}
                </button>
              ) : null}
              {contextMenu.kind === "assets" &&
              onDiscardLibraryAssetPlaceholders &&
              contextMenuDiscardablePlaceholderIds.length > 0 ? (
                <button
                  type="button"
                  className="editor-asset-context-item is-danger"
                  role="menuitem"
                  onClick={() => {
                    const ids = contextMenuDiscardablePlaceholderIds;
                    setContextMenu(null);
                    onDiscardLibraryAssetPlaceholders(ids);
                  }}
                >
                  Discard
                  {contextMenuDiscardablePlaceholderIds.length > 1
                    ? ` (${contextMenuDiscardablePlaceholderIds.length})`
                    : ""}
                </button>
              ) : null}
              {contextMenu.kind === "assets" &&
              onRemoveAssets &&
              !contextMenuHasGroupMembers &&
              contextMenuRemovableAssetIds.length > 0 ? (
                <button
                  type="button"
                  className="editor-asset-context-item"
                  role="menuitem"
                  onClick={() => {
                    const ids = contextMenuRemovableAssetIds;
                    setContextMenu(null);
                    onRemoveAssets(ids);
                  }}
                >
                  Remove
                  {contextMenuRemovableAssetIds.length > 1
                    ? ` (${contextMenuRemovableAssetIds.length})`
                    : ""}
                </button>
              ) : null}
              {contextMenu.kind === "assets" &&
              onDeleteAssets &&
              contextMenu.assetIds.every(isLocalOnlyAsset) ? (
                <button
                  type="button"
                  className="editor-asset-context-item is-danger"
                  role="menuitem"
                  onClick={() => {
                    const ids = contextMenu.assetIds;
                    setContextMenu(null);
                    onDeleteAssets(ids);
                  }}
                >
                  Delete{contextMenu.assetIds.length > 1 ? ` (${contextMenu.assetIds.length})` : ""}
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
}
