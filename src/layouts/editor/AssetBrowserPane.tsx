import { listen } from "@tauri-apps/api/event";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { AudioWaveform } from "../../library/AudioWaveform";
import { ensureLocal, getCreation } from "../../library/catalogClient";
import { creationCardTitle } from "../../library/creationFlags";
import { isLocalOnlyCreation } from "../../library/creationFilters";
import { FolderCard } from "../../library/FolderCard";
import type { LibraryFolder } from "../../library/folderClient";
import {
  canFetchLocal,
  creationPreviewUrl,
  isParasceneUnavailable,
} from "../../library/previewUrl";
import type { Creation, MediaType } from "../../library/types";
import { isPreviewDecoded, whenPreviewReady } from "../../library/warmPreviews";
import type { ProjectAsset } from "../../project/types";

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
  onDeleteAssets?: (ids: string[]) => void;
  onRemoveAssets?: (ids: string[]) => void;
  onRemoveFolders?: (ids: string[]) => void;
};

type AssetContextMenu =
  | { kind: "assets"; assetIds: string[]; x: number; y: number }
  | { kind: "folders"; folderIds: string[]; x: number; y: number };

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

function AssetThumb({
  kind,
  creation,
}: {
  kind: ProjectAsset["kind"];
  creation: Creation | undefined;
}) {
  const preview = creation ? creationPreviewUrl(creation) : null;
  const unavailable = creation ? isParasceneUnavailable(creation) : false;
  const waitingOnDisk = Boolean(creation) && !preview && !unavailable;
  const [paintSrc, setPaintSrc] = useState<string | null>(() =>
    preview && isPreviewDecoded(preview) ? preview : null,
  );

  useLayoutEffect(() => {
    if (!preview) {
      setPaintSrc(null);
      return;
    }
    if (isPreviewDecoded(preview)) {
      setPaintSrc(preview);
      return;
    }
    let cancelled = false;
    void whenPreviewReady(preview).then(() => {
      if (!cancelled) setPaintSrc(preview);
    });
    return () => {
      cancelled = true;
    };
  }, [preview]);

  useEffect(() => {
    if (!creation || unavailable || !canFetchLocal(creation) || preview) {
      return;
    }
    void ensureLocal([creation.id], { fullMedia: false });
  }, [creation, unavailable, preview]);

  const showImage = Boolean(paintSrc && paintSrc === preview);
  // Decorative icon — always for audio kind (no need for local media first).
  const showAudio = kind === "audio" && !showImage;
  const showPending =
    !showAudio && (waitingOnDisk || (Boolean(preview) && !showImage));
  const label = kind === "video" ? "Video" : kind === "audio" ? "Audio" : "Image";

  return (
    <div
      className={[
        "editor-asset-thumb",
        `kind-${kind}`,
        showPending ? "is-pending" : "",
        unavailable && !showAudio ? "is-broken" : "",
        showImage ? "has-image" : "",
        showAudio ? "is-audio" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden
    >
      {showImage ? (
        <img src={paintSrc!} alt="" loading="eager" decoding="async" draggable={false} />
      ) : showAudio ? (
        <span className="editor-asset-audio-icon">
          <AudioWaveform className="editor-asset-audio-wave" />
        </span>
      ) : showPending ? (
        <span className="editor-asset-thumb-shimmer" />
      ) : (
        <span className="editor-asset-thumb-label">{label}</span>
      )}
      {kind === "video" && showImage ? (
        <span className="editor-asset-play-badge" />
      ) : null}
    </div>
  );
}

export function AssetBrowserPane({
  assets,
  folders = [],
  filter,
  selectedId,
  selectedIds,
  onFilterChange,
  onSelectionChange,
  onCollapse,
  drawer = false,
  previewActive = false,
  onDeleteAssets,
  onRemoveAssets,
  onRemoveFolders,
}: AssetBrowserPaneProps) {
  const [creationsById, setCreationsById] = useState<
    Record<string, Creation>
  >({});
  const [contextMenu, setContextMenu] = useState<AssetContextMenu | null>(null);
  const [folderViewId, setFolderViewId] = useState<string | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);

  const folderView =
    folders.find((folder) => folder.id === folderViewId) ?? null;

  useEffect(() => {
    if (folderViewId && !folders.some((folder) => folder.id === folderViewId)) {
      setFolderViewId(null);
    }
  }, [folderViewId, folders]);

  const filedInProjectFolders = useMemo(() => {
    const ids = new Set<string>();
    for (const folder of folders) {
      for (const memberId of folder.memberIds) ids.add(memberId);
    }
    return ids;
  }, [folders]);

  const rootAssets = useMemo(() => {
    if (folderView) {
      const members = new Set(folderView.memberIds);
      return assets.filter((asset) => members.has(asset.id));
    }
    return assets.filter((asset) => !filedInProjectFolders.has(asset.id));
  }, [assets, filedInProjectFolders, folderView]);

  const assetIdsKey = useMemo(
    () => rootAssets.map((a) => a.id).join("\0"),
    [rootAssets],
  );

  useEffect(() => {
    if (!contextMenu) return;

    let close: (() => void) | null = null;
    let onKey: ((event: KeyboardEvent) => void) | null = null;
    let onScroll: (() => void) | null = null;

    // Defer so the opening right-click doesn't immediately dismiss the menu.
    const timer = window.setTimeout(() => {
      close = () => setContextMenu(null);
      onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") close?.();
      };
      onScroll = () => close?.();
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", onScroll, true);
    }, 0);

    return () => {
      window.clearTimeout(timer);
      if (close) window.removeEventListener("pointerdown", close);
      if (onKey) window.removeEventListener("keydown", onKey);
      if (onScroll) window.removeEventListener("scroll", onScroll, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    setContextMenu(null);
  }, [assetIdsKey]);

  useEffect(() => {
    const ids = assetIdsKey ? assetIdsKey.split("\0") : [];
    if (ids.length === 0) {
      setCreationsById({});
      return;
    }

    let cancelled = false;

    const load = async () => {
      const next: Record<string, Creation> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            next[id] = await getCreation(id);
          } catch {
            // Not in local catalog (fixture ids / stale references).
          }
        }),
      );
      if (cancelled) return;
      setCreationsById(next);

      const needThumbs = Object.values(next)
        .filter((c) => !creationPreviewUrl(c) && canFetchLocal(c))
        .map((c) => c.id);
      if (needThumbs.length > 0) {
        void ensureLocal(needThumbs, { fullMedia: false });
      }
    };

    void load();

    let unlisten: (() => void) | undefined;
    void listen<Creation>("library-creation-updated", (event) => {
      const row = event.payload;
      if (!ids.includes(row.id)) return;
      setCreationsById((prev) => ({ ...prev, [row.id]: row }));
    }).then((off) => {
      unlisten = off;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [assetIdsKey]);

  const visible = rootAssets.filter((asset) => {
    if (filter === "all") return true;
    return kindFromCreation(creationsById[asset.id], asset.kind) === filter;
  });

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
    return creation ? isLocalOnlyCreation(creation) : false;
  };

  const openContextMenu = (
    assetId: string,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (!onDeleteAssets && !onRemoveAssets) return;
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
    folderId: string,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (!onRemoveFolders) return;
    setContextMenu({
      kind: "folders",
      folderIds: [folderId],
      x: event.clientX,
      y: event.clientY,
    });
  };

  const selectAsset = (
    assetId: string,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
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

      <div className="editor-asset-scroll">
        {visible.length === 0 && !showRootFolders ? (
          <p className="muted editor-asset-empty">No assets in this filter.</p>
        ) : (
          <ul className="editor-asset-grid">
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
              const kind = kindFromCreation(creation, asset.kind);
              const name = displayName(asset, creation);
              return (
                <li key={asset.id}>
                  <button
                    type="button"
                    className={
                      selectedIds.includes(asset.id)
                        ? "editor-asset-tile is-selected"
                        : "editor-asset-tile"
                    }
                    onClick={(event) => selectAsset(asset.id, event)}
                    onContextMenu={(event) => openContextMenu(asset.id, event)}
                    title={name}
                  >
                    <AssetThumb kind={kind} creation={creation} />
                    <span className="editor-asset-meta">
                      <span className="editor-asset-kind">{kind}</span>
                      <span className="editor-asset-name">{name}</span>
                      {(kind === "video" || kind === "audio") && (
                        <span className="editor-asset-duration muted">
                          {asset.durationLabel ?? "—"}
                        </span>
                      )}
                    </span>
                  </button>
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
              {contextMenu.kind === "folders" && onRemoveFolders ? (
                <button
                  type="button"
                  className="editor-asset-context-item"
                  role="menuitem"
                  onClick={() => {
                    const ids = contextMenu.folderIds;
                    setContextMenu(null);
                    onRemoveFolders(ids);
                  }}
                >
                  Remove folder from project
                </button>
              ) : null}
              {contextMenu.kind === "assets" && onRemoveAssets ? (
                <button
                  type="button"
                  className="editor-asset-context-item"
                  role="menuitem"
                  onClick={() => {
                    const ids = contextMenu.assetIds;
                    setContextMenu(null);
                    onRemoveAssets(ids);
                  }}
                >
                  Remove{contextMenu.assetIds.length > 1 ? ` (${contextMenu.assetIds.length})` : ""}
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
