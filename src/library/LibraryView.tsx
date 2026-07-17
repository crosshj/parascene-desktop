/**
 * Library UI contract
 * -------------------
 * Frontend: read SQLite pages, paint local disk paths only, show sync status.
 * Backend warms thumbs several pages ahead of scroll (highest priority); cards
 * only call `ensureLocal` as a visible bump. Never load remote media URLs.
 */
import { listen } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShell } from "../app/ShellProvider";
import { CreationsFilterEmpty } from "./CreationsFilterEmpty";
import { runCloudLibraryRepair } from "../sync/cloudRepair";
import {
  syncCreationsManifest,
  syncCreationsMetadata,
} from "../sync/manifestSync";
import {
  applySyncItemEvent,
  clearFinishedSyncActivity,
  countFinishedSyncActivity,
  MAX_FINISHED_SYNC_ACTIVITY,
  syncItemKindLabel,
  syncItemStateLabel,
  type SyncActivityItem,
  type SyncItemEvent,
} from "../sync/syncActivity";
import {
  formatLastSync,
  phaseLabel,
  syncCountsSummary,
  syncDiskSummary,
  unsyncableMediaCount,
  unsyncableThumbCount,
  withoutCloudUrlLabel,
} from "../sync/syncState";
import {
  EMPTY_FILTER_TOGGLES,
  activeFilterId,
  filterCreationsVisible,
  folderBoardAspect,
  folderCollageMemberIds,
  folderMatchesFilters,
  folderNeedsMemberCreations,
  mergeFilterCounts,
  selectFilter,
  togglesFromFilterId,
  type CreationFilterToggles,
  type FilterId,
} from "./creationFilters";
import { CreationsSidebar } from "./CreationsSidebar";
import {
  cacheMissingMedia,
  cacheMissingThumbs,
  ensureLocal,
  getCatalogFilterCounts,
  getCreation,
  getCreations,
  getSyncStatus,
  importFromDisk,
  listCreationsPage,
} from "./catalogClient";
import { CreationLightbox } from "./CreationLightbox";
import { FolderCreateModal } from "./FolderCreateModal";
import { FolderEditModal } from "./FolderEditModal";
import { FolderPickModal } from "./FolderPickModal";
import {
  addToFolder,
  createFolder,
  listFiledCreationIds,
  listFolders,
  omitFiledCreations,
  removeFromFolder,
  renameFolder,
  type LibraryFolder,
} from "./folderClient";
import { VirtualCreationsGrid } from "./VirtualCreationsGrid";
import {
  CREATIONS_LOAD_MORE_PAGES,
  CREATIONS_PAGE_SIZE,
  type CatalogFilterCounts,
  type Creation,
  type DownloadProgress,
  type SyncStatus,
} from "./types";

const SIDEBAR_WIDTH_KEY = "parascene.creationsSidebarWidth";
const SIDEBAR_DEFAULT_WIDTH = 220;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 360;

function hasLayoutAspect(c: Creation): boolean {
  return Boolean(c.aspectRatio) || (Boolean(c.width) && Boolean(c.height));
}

function SyncFromCloudButton({
  active,
  disabled,
  onSync,
  progress,
}: {
  /** True only while catalog sync is the active operation. */
  active: boolean;
  disabled?: boolean;
  onSync: () => void;
  progress: DownloadProgress | null;
}) {
  let label = "Sync from cloud";
  if (active && progress?.phase === "catalog") {
    label = "Updating catalog…";
  } else if (active && progress && progress.total > 0) {
    const phase =
      progress.phase === "thumbs"
        ? "Previews"
        : progress.phase === "media"
          ? "Media"
          : "Downloading";
    label = `${phase} ${progress.done}/${progress.total}…`;
  } else if (active) {
    label = "Syncing…";
  }
  return (
    <button
      type="button"
      className="btn btn-primary"
      onClick={onSync}
      disabled={disabled ?? active}
    >
      {label}
    </button>
  );
}

function useCatalog() {
  const [creations, setCreations] = useState<Creation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [activity, setActivity] = useState<SyncActivityItem[]>([]);
  const offsetRef = useRef(0);
  const creationsRef = useRef<Creation[]>([]);
  const aspectBackfillStarted = useRef(false);
  const loadingMoreRef = useRef(false);

  const loadInitial = useCallback(async () => {
    const [page, sync] = await Promise.all([
      listCreationsPage({ limit: CREATIONS_PAGE_SIZE, offset: 0 }),
      getSyncStatus(),
    ]);
    offsetRef.current = page.creations.length;
    creationsRef.current = page.creations;
    setCreations(page.creations);
    setTotal(page.total);
    setHasMore(page.hasMore);
    setStatus(sync);
    setError(null);
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      // Pull multiple pages per near-end so the board stays ahead of scroll.
      let more = true;
      for (let pageIdx = 0; pageIdx < CREATIONS_LOAD_MORE_PAGES && more; pageIdx++) {
        const page = await listCreationsPage({
          limit: CREATIONS_PAGE_SIZE,
          offset: offsetRef.current,
        });
        const next = [...creationsRef.current, ...page.creations];
        creationsRef.current = next;
        setCreations(next);
        offsetRef.current = next.length;
        setTotal(page.total);
        more = page.hasMore;
        setHasMore(more);
        if (page.creations.length === 0) break;
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore]);

  useEffect(() => {
    let cancelled = false;
    loadInitial().catch((e: unknown) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : String(e));
        setCreations([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadInitial]);

  // One-shot metadata refresh if the local catalog predates aspect fields.
  useEffect(() => {
    if (!creations?.length || aspectBackfillStarted.current) return;
    const missing = creations.filter((c) => !hasLayoutAspect(c)).length;
    if (missing < creations.length * 0.5) return;
    aspectBackfillStarted.current = true;
    let cancelled = false;
    void syncCreationsMetadata()
      .then(async (next) => {
        if (cancelled) return;
        setStatus(next);
        await loadInitial();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [creations, loadInitial]);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenRow: (() => void) | undefined;
    let unlistenDeleted: (() => void) | undefined;
    let unlistenSyncItem: (() => void) | undefined;
    let statusRefreshTimer: number | undefined;
    let lastStatusRefresh = 0;

    const refreshStatus = () => {
      const now = Date.now();
      if (now - lastStatusRefresh < 800) return;
      lastStatusRefresh = now;
      void getSyncStatus()
        .then(setStatus)
        .catch(() => {});
    };

    void listen<DownloadProgress>("library-download-progress", (event) => {
      setProgress(event.payload);
      refreshStatus();
      window.clearTimeout(statusRefreshTimer);
      // Settle counts shortly after the last progress tick.
      statusRefreshTimer = window.setTimeout(() => {
        void getSyncStatus()
          .then(setStatus)
          .catch(() => {});
      }, 600);
    }).then((off) => {
      unlistenProgress = off;
    });

    void listen<SyncItemEvent>("library-sync-item", (event) => {
      setActivity((prev) => applySyncItemEvent(prev, event.payload));
    }).then((off) => {
      unlistenSyncItem = off;
    });

    // Backend pushed a row change (thumb/media landed) — patch in place.
    // Coalesce bursts of updates so thousands of thumb finishes don't freeze React.
    const pendingRows = new Map<string, Creation>();
    let rowFlushRaf = 0;
    const flushRowUpdates = () => {
      rowFlushRaf = 0;
      if (pendingRows.size === 0) return;
      const patch = new Map(pendingRows);
      pendingRows.clear();
      let changed = false;
      const merged = creationsRef.current.map((c) => {
        const next = patch.get(c.id);
        if (!next || next === c) return c;
        changed = true;
        return next;
      });
      if (!changed) return;
      creationsRef.current = merged;
      setCreations(merged);
      refreshStatus();
    };
    void listen<Creation>("library-creation-updated", (event) => {
      pendingRows.set(event.payload.id, event.payload);
      if (rowFlushRaf) return;
      rowFlushRaf = window.requestAnimationFrame(flushRowUpdates);
    }).then((off) => {
      unlistenRow = () => {
        if (rowFlushRaf) window.cancelAnimationFrame(rowFlushRaf);
        off();
      };
    });

    void listen<string>("library-creation-deleted", (event) => {
      const id = event.payload;
      const next = creationsRef.current.filter((c) => c.id !== id);
      creationsRef.current = next;
      setCreations(next);
      offsetRef.current = next.length;
      setTotal((t) => Math.max(0, t - 1));
      refreshStatus();
    }).then((off) => {
      unlistenDeleted = off;
    });

    return () => {
      unlistenProgress?.();
      unlistenRow?.();
      unlistenDeleted?.();
      unlistenSyncItem?.();
      window.clearTimeout(statusRefreshTimer);
    };
  }, []);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    setProgress({
      done: 0,
      total: 0,
      currentId: null,
      failed: 0,
      phase: "catalog",
    });
    try {
      const next = await syncCreationsManifest();
      setStatus(next);
      await loadInitial();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
      // Keep last progress visible briefly; background ensure may still emit.
    }
  }, [loadInitial]);

  const runCacheThumbs = useCallback(async () => {
    setError(null);
    setProgress({
      done: 0,
      total: 0,
      currentId: null,
      failed: 0,
      phase: "thumbs",
    });
    try {
      const summary = await cacheMissingThumbs();
      setStatus(summary.status);
      if (summary.skipped === 0 && summary.downloaded === 0) {
        setProgress(null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const runCacheMedia = useCallback(async () => {
    setError(null);
    setProgress({
      done: 0,
      total: 0,
      currentId: null,
      failed: 0,
      phase: "media",
    });
    try {
      const summary = await cacheMissingMedia();
      setStatus(summary.status);
      if (summary.skipped === 0 && summary.downloaded === 0) {
        setProgress(null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const runCloudRepair = useCallback(async () => {
    setRepairing(true);
    setError(null);
    setProgress({
      done: 0,
      total: 0,
      currentId: null,
      failed: 0,
      phase: "repair",
    });
    try {
      const summary = await runCloudLibraryRepair({
        onPhase: (phase) => {
          const note =
            phase === "local-fit-plan"
              ? "Scanning local thumbs…"
              : phase === "group-aspect"
                ? "Updating group aspects…"
                : phase === "local-fill"
                  ? "Rebuilding mismatched thumbs…"
                  : phase === "upload-existing-fit"
                    ? "Uploading local fits…"
                    : phase === "fit-thumbnails"
                      ? "Cloud fit for items without media…"
                      : phase === "resync"
                        ? "Refreshing catalog…"
                        : phase === "redownload-thumbs"
                          ? "Refreshing previews…"
                          : null;
          setProgress({
            done: 0,
            total: 0,
            currentId: note,
            failed: 0,
            phase: phase === "redownload-thumbs" ? "thumbs" : "repair",
          });
        },
        onWait: (ms) => {
          const secs = Math.max(1, Math.ceil(ms / 1000));
          setProgress({
            done: 0,
            total: 0,
            currentId: `Waiting ${secs}s for rate limit…`,
            failed: 0,
            phase: "repair",
          });
          window.setTimeout(() => {
            setProgress((prev) =>
              prev?.phase === "repair" &&
              typeof prev.currentId === "string" &&
              prev.currentId.startsWith("Waiting")
                ? { ...prev, currentId: null }
                : prev,
            );
          }, ms);
        },
        onItem: (event) => {
          setActivity((prev) => applySyncItemEvent(prev, event));
        },
      });
      const next = await getSyncStatus();
      setStatus(next);
      await loadInitial();
      if (
        summary.group.updated_count === 0 &&
        summary.fit.updated_count === 0 &&
        summary.localFilled === 0 &&
        summary.uploadedOnly === 0
      ) {
        setProgress(null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRepairing(false);
    }
  }, [loadInitial]);

  const refreshStatus = useCallback(() => {
    void getSyncStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  const clearFinishedActivity = useCallback(() => {
    setActivity((prev) => clearFinishedSyncActivity(prev));
  }, []);

  const [importing, setImporting] = useState(false);
  const runImportFromDisk = useCallback(async () => {
    setImporting(true);
    setError(null);
    try {
      const result = await importFromDisk();
      if (result.cancelled) return;
      setStatus(result.status);
      await loadInitial();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [loadInitial]);

  return {
    creations,
    total,
    hasMore,
    status,
    error,
    syncing,
    repairing,
    loadingMore,
    importing,
    progress,
    activity,
    runSync,
    runCacheThumbs,
    runCacheMedia,
    runCloudRepair,
    runImportFromDisk,
    clearFinishedActivity,
    loadMore,
    refreshStatus,
  };
}

function creationsChromeStatus(opts: {
  creations: Creation[] | null;
  visibleCount: number;
  filterActive: boolean;
  total: number;
  syncing: boolean;
  loadingMore: boolean;
  progress: DownloadProgress | null;
}): string | null {
  const {
    creations,
    visibleCount,
    filterActive,
    total,
    syncing,
    loadingMore,
    progress,
  } = opts;
  if (creations === null) return "Loading catalog…";
  if (creations.length === 0) return null;
  if (syncing && progress && progress.total > 0) {
    const phase = progress.phase === "thumbs" ? "Previews" : "Media";
    return `${phase} ${progress.done} of ${progress.total}…`;
  }
  if (syncing) return "Syncing from cloud…";
  if (loadingMore) return "Loading more…";
  if (progress && progress.total > 0) {
    const phase = progress.phase === "thumbs" ? "previews" : "media";
    return `Caching ${phase} ${progress.done} of ${progress.total}…`;
  }
  if (filterActive) {
    return `Showing ${visibleCount} matching · ${creations.length} loaded of ${total}`;
  }
  return `Showing ${creations.length} of ${total}`;
}

function CreationsPanel({
  creations,
  total,
  error,
  syncing,
  loadingMore,
  progress,
  onSync,
  onLoadMore,
  onImportFromDisk,
  importing,
}: {
  creations: Creation[] | null;
  total: number;
  error: string | null;
  syncing: boolean;
  loadingMore: boolean;
  progress: DownloadProgress | null;
  onSync: () => void;
  onLoadMore: () => void;
  onImportFromDisk: () => void;
  importing: boolean;
}) {
  const {
    setChromeStatus,
    openProjectId,
    project,
    createProject,
    addCreationsToOpenProject,
    addFoldersToOpenProject,
    creationsFilterId,
    setCreationsFilterId,
  } = useShell();
  const [active, setActive] = useState<Creation | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [filedIds, setFiledIds] = useState<Set<string>>(() => new Set());
  const [folderViewId, setFolderViewId] = useState<string | null>(null);
  /** Members loaded by id — not the paginated home catalog. */
  const [folderMembers, setFolderMembers] = useState<Creation[] | null>(null);
  const [folderMembersLoading, setFolderMembersLoading] = useState(false);
  /** Member rows used to decide which folders match the active filter. */
  const [folderFilterMembersById, setFolderFilterMembersById] = useState<
    Map<string, Creation>
  >(() => new Map());
  const [folderFilterMembersLoading, setFolderFilterMembersLoading] =
    useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [pickFolderOpen, setPickFolderOpen] = useState(false);
  const [editFolder, setEditFolder] = useState<LibraryFolder | null>(null);
  /** Sidebar highlight — updates immediately on click. */
  const [sidebarFilters, setSidebarFilters] = useState<CreationFilterToggles>(
    () => togglesFromFilterId(creationsFilterId),
  );
  /** Grid filter — applied after a blank frame so the switch feels instant. */
  const [gridFilters, setGridFilters] = useState<CreationFilterToggles>(() =>
    togglesFromFilterId(creationsFilterId),
  );
  const [gridBlank, setGridBlank] = useState(false);
  const sidebarFiltersRef = useRef(sidebarFilters);
  sidebarFiltersRef.current = sidebarFilters;
  const filterApplyGen = useRef(0);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      const n = raw ? Number(raw) : SIDEBAR_DEFAULT_WIDTH;
      if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_WIDTH;
      return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, n));
    } catch {
      return SIDEBAR_DEFAULT_WIDTH;
    }
  });
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [catalogCounts, setCatalogCounts] = useState<CatalogFilterCounts | null>(
    null,
  );
  const [deferredKeepIds, setDeferredKeepIds] = useState<Set<string>>(
    () => new Set(),
  );
  const empty = creations !== null && creations.length === 0 && folders.length === 0;

  const refreshFolders = useCallback(async () => {
    try {
      const [nextFolders, filed] = await Promise.all([
        listFolders(),
        listFiledCreationIds(),
      ]);
      setFolders(nextFolders);
      setFiledIds(new Set(filed));
      setFolderViewId((current) => {
        if (!current) return null;
        return nextFolders.some((folder) => folder.id === current)
          ? current
          : null;
      });
    } catch (error) {
      console.error("Failed to load folders", error);
    }
  }, []);

  useEffect(() => {
    void refreshFolders();
  }, [refreshFolders, creations?.length, total]);

  const folderView = useMemo(
    () => folders.find((folder) => folder.id === folderViewId) ?? null,
    [folderViewId, folders],
  );

  const folderMemberIdsKey = folderView?.memberIds.join("\0") ?? "";
  const homeFolderMemberIdsKey = useMemo(
    () =>
      folders
        .map((folder) => `${folder.id}:${folder.memberIds.join(",")}`)
        .join("|"),
    [folders],
  );
  const needsFolderMemberFilter = folderNeedsMemberCreations(gridFilters);
  const folderFilterCacheRef = useRef<Map<string, Creation>>(new Map());
  const folderFilterFetchKeyRef = useRef<string>("");

  useEffect(() => {
    if (folderView || !needsFolderMemberFilter) {
      setFolderFilterMembersLoading(false);
      return;
    }
    if (folders.length === 0) {
      folderFilterFetchKeyRef.current = "";
      setFolderFilterMembersById(new Map());
      setFolderFilterMembersLoading(false);
      return;
    }

    const ids = [...new Set(folders.flatMap((folder) => folder.memberIds))];
    const fetchKey = homeFolderMemberIdsKey;
    const cache = folderFilterCacheRef.current;
    const publishFromCache = () => {
      const next = new Map<string, Creation>();
      for (const id of ids) {
        const row = cache.get(id);
        if (row) next.set(id, row);
      }
      setFolderFilterMembersById(next);
      setFolderFilterMembersLoading(false);
    };

    // Same membership snapshot already loaded — avoid setState churn / loops.
    if (folderFilterFetchKeyRef.current === fetchKey) {
      return;
    }

    const missing = ids.filter((id) => !cache.has(id));
    if (missing.length === 0) {
      folderFilterFetchKeyRef.current = fetchKey;
      publishFromCache();
      return;
    }

    let cancelled = false;
    // Keep showing previous matches while we fill gaps — only blank on cold start.
    if (cache.size === 0) setFolderFilterMembersLoading(true);

    void getCreations(missing)
      .then((rows) => {
        if (cancelled) return;
        for (const row of rows) cache.set(row.id, row);
        folderFilterFetchKeyRef.current = fetchKey;
        publishFromCache();
      })
      .catch((error) => {
        console.error("Failed to load folder members for filter", error);
        if (cancelled) return;
        folderFilterFetchKeyRef.current = "";
        setFolderFilterMembersLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    folderView,
    folders,
    homeFolderMemberIdsKey,
    needsFolderMemberFilter,
  ]);

  useEffect(() => {
    if (!folderView) {
      setFolderMembers(null);
      setFolderMembersLoading(false);
      return;
    }
    let cancelled = false;
    setFolderMembersLoading(true);
    void getCreations(folderView.memberIds)
      .then((rows) => {
        if (cancelled) return;
        setFolderMembers(rows);
        setFolderMembersLoading(false);
      })
      .catch((error) => {
        console.error("Failed to load folder members", error);
        if (cancelled) return;
        setFolderMembers([]);
        setFolderMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folderView, folderMemberIdsKey]);

  useEffect(() => {
    if (!folderView) return;
    const memberSet = new Set(folderView.memberIds);
    let unlisten: (() => void) | undefined;
    void listen<Creation>("library-creation-updated", (event) => {
      const row = event.payload;
      if (!memberSet.has(row.id)) return;
      setFolderMembers((prev) => {
        if (!prev) return prev;
        const index = prev.findIndex((c) => c.id === row.id);
        if (index < 0) return prev;
        const next = [...prev];
        next[index] = row;
        return next;
      });
    }).then((off) => {
      unlisten = off;
    });
    return () => {
      unlisten?.();
    };
  }, [folderView, folderMemberIdsKey]);

  const inProjectIds = useMemo(() => {
    if (!openProjectId) return new Set<string>();
    return new Set(project.assets.map((a) => a.id));
  }, [openProjectId, project.assets]);

  const projectFolderIds = useMemo(() => {
    if (!openProjectId) return new Set<string>();
    return new Set(project.folderIds);
  }, [openProjectId, project.folderIds]);

  const filterCounts = useMemo(
    () => mergeFilterCounts(catalogCounts, selectedIds, inProjectIds),
    [catalogCounts, inProjectIds, selectedIds],
  );

  useEffect(() => {
    let cancelled = false;
    void getCatalogFilterCounts()
      .then((counts) => {
        if (!cancelled) setCatalogCounts(counts);
      })
      .catch(() => {
        if (!cancelled) setCatalogCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [total, syncing, creations?.length]);

  const sidebarFilterKey = activeFilterId(sidebarFilters);
  const gridFilterKey = activeFilterId(gridFilters);

  // Any sidebar filter change reconciles deferred dims (Selected / Not selected pins).
  useEffect(() => {
    setDeferredKeepIds(new Set());
  }, [sidebarFilterKey]);

  // Drop In project filter when the project closes.
  useEffect(() => {
    if (openProjectId) return;
    if (sidebarFilterKey !== "inProject" && gridFilterKey !== "inProject") {
      return;
    }
    setSidebarFilters(EMPTY_FILTER_TOGGLES);
    setGridFilters(EMPTY_FILTER_TOGGLES);
    setGridBlank(false);
    setCreationsFilterId("all");
  }, [gridFilterKey, openProjectId, setCreationsFilterId, sidebarFilterKey]);

  useEffect(() => {
    return () => {
      filterApplyGen.current += 1;
    };
  }, []);

  const visibleCreations = useMemo(() => {
    if (gridBlank || !creations) return [];
    if (folderView) {
      if (!folderMembers) return [];
      return filterCreationsVisible(
        folderMembers,
        gridFilters,
        selectedIds,
        deferredKeepIds,
        inProjectIds,
      );
    }
    const unfiled = omitFiledCreations(creations, filedIds);
    return filterCreationsVisible(
      unfiled,
      gridFilters,
      selectedIds,
      deferredKeepIds,
      inProjectIds,
    );
  }, [
    creations,
    deferredKeepIds,
    filedIds,
    folderMembers,
    folderView,
    gridBlank,
    gridFilters,
    inProjectIds,
    selectedIds,
  ]);

  const folderFilterCreationsById = useMemo(() => {
    const map = new Map<string, Creation>(folderFilterMembersById);
    if (creations) {
      for (const creation of creations) {
        if (!map.has(creation.id)) map.set(creation.id, creation);
      }
    }
    return map;
  }, [creations, folderFilterMembersById]);

  const homeFolderAspect = useMemo(
    () => folderBoardAspect(gridFilters),
    [gridFilters],
  );

  const homeFolders = useMemo(() => {
    if (folderView || gridBlank) return [];
    if (
      folderFilterMembersLoading &&
      needsFolderMemberFilter &&
      folderFilterMembersById.size === 0
    ) {
      return [];
    }
    return folders.filter((folder) =>
      folderMatchesFilters(
        folder,
        gridFilters,
        selectedIds,
        selectedFolderIds,
        inProjectIds,
        projectFolderIds,
        folderFilterCreationsById,
      ),
    );
  }, [
    folderFilterCreationsById,
    folderFilterMembersById.size,
    folderFilterMembersLoading,
    folderView,
    folders,
    gridBlank,
    gridFilters,
    inProjectIds,
    needsFolderMemberFilter,
    projectFolderIds,
    selectedFolderIds,
    selectedIds,
  ]);

  const folderCollageIdsByFolderId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const folder of homeFolders) {
      map.set(
        folder.id,
        folderCollageMemberIds(
          folder,
          gridFilters,
          selectedIds,
          selectedFolderIds,
          inProjectIds,
          projectFolderIds,
          folderFilterCreationsById,
        ),
      );
    }
    return map;
  }, [
    folderFilterCreationsById,
    gridFilters,
    homeFolders,
    inProjectIds,
    projectFolderIds,
    selectedFolderIds,
    selectedIds,
  ]);

  const filterEmpty =
    !gridBlank &&
    !folderMembersLoading &&
    !(folderFilterMembersLoading && needsFolderMemberFilter) &&
    visibleCreations.length === 0 &&
    homeFolders.length === 0;
  const [showFilterEmpty, setShowFilterEmpty] = useState(false);
  useEffect(() => {
    if (!filterEmpty) {
      setShowFilterEmpty(false);
      return;
    }
    const timer = window.setTimeout(() => setShowFilterEmpty(true), 320);
    return () => window.clearTimeout(timer);
  }, [filterEmpty, gridFilterKey]);

  const dimmedIds = useMemo(() => {
    const out = new Set<string>();
    if (gridFilterKey === "notSelected") {
      for (const id of deferredKeepIds) {
        if (selectedIds.has(id)) out.add(id);
      }
    } else if (gridFilterKey === "selected") {
      for (const id of deferredKeepIds) {
        if (!selectedIds.has(id)) out.add(id);
      }
    }
    return out;
  }, [deferredKeepIds, gridFilterKey, selectedIds]);

  const onToggleFilter = useCallback(
    (id: FilterId) => {
      const next = selectFilter(sidebarFiltersRef.current, id);
      // 1) Sidebar state first (same tick as blank).
      setSidebarFilters(next);
      setCreationsFilterId(activeFilterId(next));
      // 2) Blank the grid before rebuilding.
      setGridBlank(true);
      const gen = ++filterApplyGen.current;
      // 3) After paint, apply the filtered board.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (gen !== filterApplyGen.current) return;
          setGridFilters(next);
          setGridBlank(false);
        });
      });
    },
    [setCreationsFilterId],
  );

  const onToggleSelect = useCallback(
    (creation: Creation) => {
      const id = creation.id;
      const wasSelected = selectedIds.has(id);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      // Use sidebar intent so shift-select matches the highlighted filter.
      if (sidebarFilterKey === "notSelected") {
        // Selecting: pin dimmed. Deselecting a pin: unpin.
        setDeferredKeepIds((prev) => {
          const next = new Set(prev);
          if (wasSelected) next.delete(id);
          else next.add(id);
          return next;
        });
      } else if (sidebarFilterKey === "selected") {
        // Deselecting: pin dimmed. Re-selecting a pin: unpin.
        setDeferredKeepIds((prev) => {
          const next = new Set(prev);
          if (wasSelected) next.add(id);
          else next.delete(id);
          return next;
        });
      }
    },
    [selectedIds, sidebarFilterKey],
  );

  const onClearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedFolderIds(new Set());
    setDeferredKeepIds(new Set());
  }, []);

  const onToggleFolderSelect = useCallback((folder: LibraryFolder) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folder.id)) next.delete(folder.id);
      else next.add(folder.id);
      return next;
    });
  }, []);

  const onNewProjectFromSelection = useCallback(() => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const title =
      ids.length === 1
        ? "Untitled project"
        : `Project (${ids.length} assets)`;
    createProject(title, ids);
    setSelectedIds(new Set());
    setSelectedFolderIds(new Set());
    setDeferredKeepIds(new Set());
  }, [createProject, selectedIds]);

  const onAddSelectionToProject = useCallback(() => {
    if (!openProjectId || selectedIds.size === 0) return;
    addCreationsToOpenProject([...selectedIds]);
    setSelectedIds(new Set());
    setDeferredKeepIds(new Set());
  }, [addCreationsToOpenProject, openProjectId, selectedIds]);

  const onCreateFolderFromSelection = useCallback(
    async (title: string) => {
      if (selectedIds.size === 0) return;
      try {
        await createFolder(title, [...selectedIds]);
        setCreateFolderOpen(false);
        setSelectedIds(new Set());
        setDeferredKeepIds(new Set());
        await refreshFolders();
      } catch (error) {
        console.error(error);
      }
    },
    [refreshFolders, selectedIds],
  );

  const onAddSelectionToFolder = useCallback(
    async (folder: LibraryFolder) => {
      if (selectedIds.size === 0) return;
      try {
        await addToFolder(folder.id, [...selectedIds]);
        setPickFolderOpen(false);
        setSelectedIds(new Set());
        setDeferredKeepIds(new Set());
        await refreshFolders();
      } catch (error) {
        console.error(error);
      }
    },
    [refreshFolders, selectedIds],
  );

  const onRemoveSelectionFromFolder = useCallback(async () => {
    if (selectedIds.size === 0) return;
    try {
      await removeFromFolder([...selectedIds]);
      setSelectedIds(new Set());
      setDeferredKeepIds(new Set());
      await refreshFolders();
    } catch (error) {
      console.error(error);
    }
  }, [refreshFolders, selectedIds]);

  const onAddSelectedFoldersToProject = useCallback(() => {
    if (!openProjectId || selectedFolderIds.size === 0) return;
    const chosen = folders.filter((folder) => selectedFolderIds.has(folder.id));
    const folderIds = chosen.map((folder) => folder.id);
    const memberIds = [
      ...new Set(chosen.flatMap((folder) => folder.memberIds)),
    ];
    addFoldersToOpenProject(folderIds, memberIds);
    setSelectedFolderIds(new Set());
  }, [addFoldersToOpenProject, folders, openProjectId, selectedFolderIds]);

  const onSaveFolderEdit = useCallback(
    async (title: string, description: string) => {
      if (!editFolder) return;
      try {
        await renameFolder(editFolder.id, title, description);
        setEditFolder(null);
        await refreshFolders();
      } catch (error) {
        console.error(error);
      }
    },
    [editFolder, refreshFolders],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, drag.startWidth + (event.clientX - drag.startX)),
      );
      setSidebarWidth(next);
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(false);
      setSidebarWidth((w) => {
        try {
          localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
        } catch {
          // ignore
        }
        return w;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  useEffect(() => {
    if (gridBlank) {
      setChromeStatus(null);
      return () => setChromeStatus(null);
    }
    setChromeStatus(
      creationsChromeStatus({
        creations,
        visibleCount: visibleCreations.length,
        filterActive: gridFilterKey !== "all",
        total,
        syncing,
        loadingMore,
        progress,
      }),
    );
    return () => setChromeStatus(null);
  }, [
    creations,
    gridBlank,
    gridFilterKey,
    loadingMore,
    progress,
    setChromeStatus,
    syncing,
    total,
    visibleCreations.length,
  ]);

  return (
    <section className="stub-panel creations-panel" aria-label="Creations">
      {error ? <p className="library-error">{error}</p> : null}
      {creations === null ? (
        <p className="muted" style={{ padding: "1rem" }}>
          Loading catalog…
        </p>
      ) : empty ? (
        <div className="library-empty-body">
          <p className="muted">No local creations yet.</p>
          <div className="library-empty-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onImportFromDisk}
              disabled={importing || syncing}
            >
              {importing ? "Adding…" : "Add from disk…"}
            </button>
            <SyncFromCloudButton
              active={syncing}
              onSync={onSync}
              progress={progress}
            />
          </div>
        </div>
      ) : (
        <div className="creations-split">
          <CreationsSidebar
            toggles={sidebarFilters}
            counts={filterCounts}
            width={sidebarWidth}
            onToggle={onToggleFilter}
            selectedCount={selectedIds.size}
            selectedFolderCount={selectedFolderIds.size}
            hasOpenProject={Boolean(openProjectId)}
            inFolderView={Boolean(folderView)}
            hasFolders={folders.length > 0}
            onNewProject={onNewProjectFromSelection}
            onAddToProject={onAddSelectionToProject}
            onNewFolder={() => setCreateFolderOpen(true)}
            onAddToFolder={() => setPickFolderOpen(true)}
            onRemoveFromFolder={() => {
              void onRemoveSelectionFromFolder();
            }}
            onAddFolderToProject={onAddSelectedFoldersToProject}
            onClearSelection={onClearSelection}
            onAddFromDisk={onImportFromDisk}
            importing={importing}
          />
          <button
            type="button"
            className={
              dragging
                ? "creations-split-resizer is-dragging"
                : "creations-split-resizer"
            }
            aria-label="Resize filters sidebar"
            onPointerDown={(event) => {
              event.preventDefault();
              dragRef.current = {
                startX: event.clientX,
                startWidth: sidebarWidth,
              };
              setDragging(true);
            }}
          />
          <div className="creations-split-main">
            {folderView ? (
              <div className="library-folder-breadcrumb" aria-label="Folder">
                <button
                  type="button"
                  className="library-folder-home"
                  aria-label="Library home"
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
                <span className="library-folder-crumb-name">
                  {folderView.title}
                </span>
                <button
                  type="button"
                  className="library-folder-edit"
                  aria-label="Edit folder"
                  onClick={() => setEditFolder(folderView)}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                    <path
                      fill="currentColor"
                      d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm14.06-9.31 1.99-1.99a1 1 0 0 0 0-1.41l-1.59-1.59a1 1 0 0 0-1.41 0L14.06 4.94l3.75 3.75z"
                    />
                  </svg>
                </button>
              </div>
            ) : null}
            {gridBlank ||
            folderMembersLoading ||
            (folderFilterMembersLoading && needsFolderMemberFilter) ||
            (filterEmpty && !showFilterEmpty && homeFolders.length === 0) ? (
              <div
                className="creations-grid-blank"
                aria-busy={
                  gridBlank ||
                  folderMembersLoading ||
                  (folderFilterMembersLoading && needsFolderMemberFilter) ||
                  undefined
                }
              />
            ) : showFilterEmpty && homeFolders.length === 0 ? (
              <CreationsFilterEmpty />
            ) : (
              <VirtualCreationsGrid
                creations={visibleCreations}
                folders={homeFolders}
                selectedIds={selectedIds}
                selectedFolderIds={selectedFolderIds}
                dimmedIds={dimmedIds}
                inProjectIds={inProjectIds}
                layoutResetKey={`${gridFilterKey}:${folderViewId ?? "home"}`}
                folderPackHeight={homeFolderAspect.packHeight}
                folderAspectCss={homeFolderAspect.aspectCss}
                folderCollageIdsByFolderId={folderCollageIdsByFolderId}
                folderCreationsById={folderFilterCreationsById}
                onOpen={(creation) => {
                  setActive(creation);
                  if (
                    creation.downloadState !== "local" ||
                    !creation.localPath
                  ) {
                    void ensureLocal([creation.id], {
                      fullMedia: true,
                      urgent: true,
                    });
                  }
                }}
                onToggleSelect={onToggleSelect}
                onOpenFolder={(next) => {
                  setFolderViewId(next.id);
                  setSelectedIds(new Set());
                  setSelectedFolderIds(new Set());
                }}
                onToggleFolderSelect={onToggleFolderSelect}
                onNearEnd={() => {
                  if (gridFilterKey === "selected") return;
                  if (folderView) return;
                  onLoadMore();
                }}
              />
            )}
            {active ? (
              <CreationLightbox
                creation={
                  creations.find((c) => c.id === active.id) ?? active
                }
                onClose={() => setActive(null)}
                onDeleted={() => setActive(null)}
              />
            ) : null}
            {createFolderOpen ? (
              <FolderCreateModal
                onCancel={() => setCreateFolderOpen(false)}
                onCreate={(title) => {
                  void onCreateFolderFromSelection(title);
                }}
              />
            ) : null}
            {pickFolderOpen ? (
              <FolderPickModal
                folders={folders}
                onCancel={() => setPickFolderOpen(false)}
                onPick={(folder) => {
                  void onAddSelectionToFolder(folder);
                }}
              />
            ) : null}
            {editFolder ? (
              <FolderEditModal
                folder={editFolder}
                onCancel={() => setEditFolder(null)}
                onSave={(title, description) => {
                  void onSaveFolderEdit(title, description);
                }}
              />
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function SyncPanel({
  status,
  error,
  syncing,
  repairing,
  progress,
  activity,
  onSync,
  onCacheThumbs,
  onCacheMedia,
  onCloudRepair,
  onClearFinished,
  onRefreshStatus,
}: {
  status: SyncStatus | null;
  error: string | null;
  syncing: boolean;
  repairing: boolean;
  progress: DownloadProgress | null;
  activity: SyncActivityItem[];
  onSync: () => void;
  onCacheThumbs: () => void;
  onCacheMedia: () => void;
  onCloudRepair: () => void;
  onClearFinished: () => void;
  onRefreshStatus: () => void;
}) {
  const [active, setActive] = useState<Creation | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    onRefreshStatus();
    const id = window.setInterval(onRefreshStatus, 2000);
    return () => window.clearInterval(id);
  }, [onRefreshStatus]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<Creation>("library-creation-updated", (event) => {
      const next = event.payload;
      setActive((prev) => (prev && prev.id === next.id ? next : prev));
    }).then((off) => {
      unlisten = off;
    });
    return () => unlisten?.();
  }, []);

  async function openLocalDetail(id: string) {
    if (openingId) return;
    setOpeningId(id);
    try {
      const creation = await getCreation(id);
      setActive(creation);
    } catch {
      // Keep Sync usable; catalog row may have been pruned.
    } finally {
      setOpeningId(null);
    }
  }

  const missingThumbs = status?.missingThumbCacheable ?? 0;
  const missingMedia = status?.missingMediaCacheable ?? 0;
  const unsyncableThumbs = status ? unsyncableThumbCount(status) : 0;
  const unsyncableMedia = status ? unsyncableMediaCount(status) : 0;
  const cachingThumbs =
    Boolean(progress) &&
    progress!.phase === "thumbs" &&
    progress!.total > 0 &&
    progress!.done < progress!.total;
  const cachingMedia =
    Boolean(progress) &&
    progress!.phase === "media" &&
    progress!.total > 0 &&
    progress!.done < progress!.total;
  const finishedCount = countFinishedSyncActivity(activity);
  const inFlight = activity.filter(
    (item) => item.state === "queued" || item.state === "active",
  ).length;
  // Block starting a second job; only the active button shows an in-progress label.
  const rawBusy =
    syncing ||
    repairing ||
    cachingThumbs ||
    cachingMedia ||
    inFlight > 0 ||
    (status?.downloading ?? 0) > 0;
  const [stickyBusy, setStickyBusy] = useState(false);
  useEffect(() => {
    if (rawBusy) {
      setStickyBusy(true);
      return;
    }
    const t = window.setTimeout(() => setStickyBusy(false), 500);
    return () => window.clearTimeout(t);
  }, [rawBusy]);
  const busy = stickyBusy || rawBusy;
  const repairNote =
    repairing &&
    typeof progress?.currentId === "string" &&
    progress.currentId.length > 0
      ? progress.currentId
      : null;
  const batchLabel = repairNote
    ? repairNote
    : syncing && progress?.phase === "catalog"
      ? "Updating catalog…"
      : repairing
        ? "Repairing library…"
        : progress && progress.total > 0
          ? `${phaseLabel(progress.phase)} ${progress.done}/${progress.total}`
          : null;
  const finishedCapped = finishedCount >= MAX_FINISHED_SYNC_ACTIVITY;
  const finishedLabel = finishedCapped
    ? `${finishedCount} finished (capped)`
    : `${finishedCount} finished`;

  return (
    <section className="stub-panel sync-panel" aria-label="Sync">
      {error ? <p className="library-error">{error}</p> : null}
      {status === null && !error ? (
        <p className="muted">Loading sync status…</p>
      ) : null}
      {status ? (
        <div className="sync-body">
          <div className="sync-body-actions">
            <SyncFromCloudButton
              active={syncing}
              disabled={busy}
              onSync={onSync}
              progress={progress}
            />
            <button
              type="button"
              className="btn ghost"
              onClick={onCacheThumbs}
              disabled={busy || missingThumbs === 0}
            >
              {cachingThumbs
                ? `Caching previews ${progress!.done}/${progress!.total}…`
                : missingThumbs === 0
                  ? unsyncableThumbs > 0
                    ? "No cacheable previews"
                    : "Previews cached"
                  : `Cache ${missingThumbs.toLocaleString()} previews`}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={onCacheMedia}
              disabled={busy || missingMedia === 0}
            >
              {cachingMedia
                ? `Caching media ${progress!.done}/${progress!.total}…`
                : missingMedia === 0
                  ? unsyncableMedia > 0
                    ? "No cacheable media"
                    : "Media cached"
                  : `Cache ${missingMedia.toLocaleString()} media`}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={onCloudRepair}
              disabled={busy}
              title="Prefer local media to rebuild mismatched thumbs and upload fit; only call Parascene for leftovers without local files"
            >
              {repairNote
                ? repairNote
                : repairing
                  ? "Repairing library…"
                  : "Repair group aspects + fit thumbs"}
            </button>
          </div>

          <p className="muted sync-summary-line">
            {status.total.toLocaleString()} creations
            {" · "}
            {status.withThumb.toLocaleString()} previews
            {" · "}
            {status.withMedia.toLocaleString()} media
            {" · "}
            last sync {formatLastSync(status.lastSyncAt).toLowerCase()}
            {batchLabel ? ` · ${batchLabel}` : ""}
          </p>
          <p className="muted sync-summary-line">
            On disk: {syncDiskSummary(status)}
          </p>
          <p className="muted sync-summary-line sync-summary-meta">
            {syncCountsSummary(status)}
            {" · "}
            {status.rootPath}
          </p>
          {status.withoutCloudUrls.length > 0 ? (
            <div className="sync-uncacheable" aria-label="Creations without cloud URLs">
              <p className="muted sync-summary-line">
                {status.withoutCloudUrls.length.toLocaleString()} without cloud
                URLs (can&apos;t cache)
                {status.withoutCloudUrls.length >= 50
                  ? " — showing first 50"
                  : ""}
                :
              </p>
              <ul className="sync-uncacheable-list">
                {status.withoutCloudUrls.map((item) => {
                  const label = withoutCloudUrlLabel(item);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="sync-uncacheable-link"
                        title={`Open local detail (${item.id})`}
                        disabled={openingId === item.id}
                        onClick={() => {
                          void openLocalDetail(item.id);
                        }}
                      >
                        {openingId === item.id ? "Opening…" : label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : unsyncableThumbs > 0 || unsyncableMedia > 0 ? (
            <p className="muted sync-summary-line">
              {Math.max(unsyncableThumbs, unsyncableMedia).toLocaleString()}{" "}
              without cloud URLs (can&apos;t cache)
            </p>
          ) : null}

          {active ? (
            <CreationLightbox
              creation={active}
              onClose={() => setActive(null)}
              onDeleted={() => {
                setActive(null);
                onRefreshStatus();
              }}
            />
          ) : null}

          <div className="sync-queue" aria-label="Sync activity">
            <div className="sync-queue-head">
              <strong>
                Activity
                {activity.length > 0
                  ? ` · ${inFlight} active · ${finishedLabel}`
                  : ""}
              </strong>
              <button
                type="button"
                className="btn ghost"
                onClick={onClearFinished}
                disabled={finishedCount === 0}
              >
                Clear finished
              </button>
            </div>
            {finishedCapped ? (
              <p className="muted sync-queue-cap-note">
                Showing the latest {MAX_FINISHED_SYNC_ACTIVITY} finished items;
                older ones are dropped from this list.
              </p>
            ) : null}
            {activity.length === 0 ? (
              <p className="muted sync-queue-empty">
                Items appear as they queue (top → bottom). Status updates in
                place. Finished list keeps the latest{" "}
                {MAX_FINISHED_SYNC_ACTIVITY}.
              </p>
            ) : (
              <ul className="sync-queue-list">
                {activity.map((item) => (
                  <li
                    key={item.key}
                    className={`sync-queue-item is-${item.state}`}
                  >
                    <span className="sync-queue-title" title={item.title}>
                      {item.title}
                    </span>
                    <span className="sync-queue-kind muted">
                      {syncItemKindLabel(item.kind)}
                    </span>
                    <span
                      className={`sync-queue-state state-${item.state}`}
                      title={item.detail ?? undefined}
                    >
                      {syncItemStateLabel(item.state, item.kind)}
                      {item.detail &&
                      (item.state === "failed" || item.state === "skipped")
                        ? ` · ${item.detail}`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function LibraryView() {
  const { librarySurface } = useShell();
  const {
    creations,
    total,
    status,
    error,
    syncing,
    repairing,
    loadingMore,
    progress,
    runSync,
    runCacheThumbs,
    runCacheMedia,
    runCloudRepair,
    runImportFromDisk,
    clearFinishedActivity,
    activity,
    loadMore,
    refreshStatus,
    importing,
  } = useCatalog();

  return (
    <div className="library-view">
      {librarySurface === "sync" ? (
        <SyncPanel
          status={status}
          error={error}
          syncing={syncing}
          repairing={repairing}
          progress={progress}
          activity={activity}
          onSync={runSync}
          onCacheThumbs={runCacheThumbs}
          onCacheMedia={runCacheMedia}
          onCloudRepair={runCloudRepair}
          onClearFinished={clearFinishedActivity}
          onRefreshStatus={refreshStatus}
        />
      ) : (
        <CreationsPanel
          creations={creations}
          total={total}
          error={error}
          syncing={syncing}
          loadingMore={loadingMore}
          progress={progress}
          onSync={runSync}
          onLoadMore={loadMore}
          onImportFromDisk={runImportFromDisk}
          importing={importing}
        />
      )}
    </div>
  );
}
