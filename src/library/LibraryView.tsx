/**
 * Library UI contract
 * -------------------
 * Frontend: read SQLite pages, paint local disk paths only.
 * Network belongs on the Sync page (user-started) and on Generate.
 * Looking at Library / groups never starts downloads.
 */
import { listen } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../auth/AuthProvider";
import { isSessionReauthError } from "../auth/errors";
import { useShell } from "../app/ShellProvider";
import type { LibrarySurface } from "../app/shellSession";
import { useConfirm } from "../ui/ConfirmDialog";
import { identifyDesktopCabinet } from "../project/desktopProjectGroups";
import {
  appendMembersToGroupCover,
  followUpDesktopCabinetGroupAppend,
} from "./libraryGroupMembers";
import {
  buildGroupMembershipByMemberId,
  resolveLibraryGroupAddTarget,
} from "./libraryGroupAddTarget";
import { CreationsFilterEmpty, FolderEmpty } from "./CreationsFilterEmpty";
import { runCloudRepair as runCloudRepairService } from "../services/cloudRepair";
import {
  folderConflictKindLabel,
  type FolderConflict,
  type FolderSyncResult,
} from "../sync/folderSync";
import {
  syncGroupMembersManifest,
  NEWEST_SYNC_MAX_PAGES,
  NEWEST_SYNC_PAGE_SIZE,
} from "../sync/manifestSync";
import { runSyncFull, runSyncNewest } from "../services/syncCatalog";
import {
  catalogJobHeadline,
  catalogJobMode,
  useBackgroundCatalogJob,
} from "./backgroundCatalogJob";
import { syncSessionUserAvatar } from "../sync/avatarSync";
import {
  applySyncItemEvent,
  clearFinishedSyncActivity,
  partitionSyncActivity,
  syncItemKindLabel,
  syncItemStateLabel,
  type SyncActivityItem,
  type SyncItemEvent,
} from "../sync/syncActivity";
import {
  formatLastSync,
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
  boardColumnLayoutForFilter,
  folderCollageMemberIds,
  folderFilteredMemberCount,
  folderMatchesFilters,
  folderNeedsMemberCreations,
  mergeFilterCounts,
  selectFilter,
  togglesFromFilterId,
  type CreationFilterToggles,
  type FilterId,
} from "./creationFilters";
import { CreationsSidebar } from "./CreationsSidebar";
import { LibraryPageSkeleton } from "./LibraryLoadingSkeleton";
import {
  cacheMissingMedia,
  cacheMissingThumbs,
  getCatalogFilterCounts,
  getCreation,
  getCreations,
  getSyncStatus,
  importFromDisk,
  isCatalogListFilterId,
  listCreationsForFilter,
  listCreationsPage,
  listGroupMemberIds,
  mergeCreationsById,
} from "./catalogClient";
import { CreationLightbox } from "./CreationLightbox";
import { FolderCreateModal } from "./FolderCreateModal";
import { FolderEditModal } from "./FolderEditModal";
import { FolderPickModal } from "./FolderPickModal";
import {
  addToFolder,
  createFolder,
  deleteFolder,
  getFolderSyncState,
  isEmptyRegularFolder,
  listFiledCreationIds,
  listFolders,
  omitFiledCreations,
  removeFromFolder,
  renameFolder,
  setFolderCover,
  type FolderSyncState,
  type LibraryFolder,
} from "./folderClient";
import {
  omitFolderMembersHiddenByCovers,
  omitGroupMemberCreations,
} from "./creationFlags";
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

type CatalogSyncMode = "newest" | "full";

function catalogSyncLabel(
  mode: CatalogSyncMode,
  active: boolean,
  progress: DownloadProgress | null,
): string {
  const idle = mode === "newest" ? "Sync newest" : "Sync full catalog";
  if (!active) return idle;
  if (progress?.phase === "catalog") {
    return mode === "newest" ? "Syncing newest…" : "Updating catalog…";
  }
  if (progress && progress.total > 0) {
    const phase =
      progress.phase === "thumbs"
        ? "Previews"
        : progress.phase === "media"
          ? "Media"
          : "Downloading";
    return `${phase} ${progress.done}/${progress.total}…`;
  }
  return mode === "newest" ? "Syncing newest…" : "Syncing…";
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

function CatalogSyncButton({
  mode,
  active,
  disabled,
  onSync,
  progress,
  primary,
}: {
  mode: CatalogSyncMode;
  active: boolean;
  disabled?: boolean;
  onSync: () => void;
  progress: DownloadProgress | null;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={primary ? "btn btn-primary" : "btn ghost"}
      onClick={onSync}
      disabled={disabled ?? active}
      title={
        mode === "newest"
          ? "Fetch the newest creations (up to ~100) and clear recent remote deletions from local. Use Sync full catalog to rebuild the whole catalog."
          : "Refresh every creation in your Parascene catalog (metadata only — not group members or media files)"
      }
    >
      {catalogSyncLabel(mode, active, progress)}
    </button>
  );
}

function useCatalog(librarySurface: LibrarySurface) {
  const { reconcileProjectsAfterLibrarySync, syncProjectFolders } = useShell();
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
  const [folderSync, setFolderSync] = useState<FolderSyncState | null>(null);
  const [folderSyncResult, setFolderSyncResult] =
    useState<FolderSyncResult | null>(null);
  const [folderConflicts, setFolderConflicts] = useState<FolderConflict[]>([]);
  const [folderResolutions, setFolderResolutions] = useState<
    Record<string, "local" | "cloud">
  >({});
  const [folderSyncing, setFolderSyncing] = useState(false);
  const [resolvingFolders, setResolvingFolders] = useState(false);
  const [catalogSyncMode, setCatalogSyncMode] =
    useState<CatalogSyncMode | null>(null);
  const [syncHeadline, setSyncHeadline] = useState<string | null>(null);
  const [cachingKind, setCachingKind] = useState<"thumbs" | "media" | null>(
    null,
  );
  const [syncingGroups, setSyncingGroups] = useState(false);
  const offsetRef = useRef(0);
  const creationsRef = useRef<Creation[]>([]);
  const loadingMoreRef = useRef(false);
  const surfaceRef = useRef(librarySurface);
  // Keep a latest-value ref for async callbacks (read after commit, not during render).
  useEffect(() => {
    surfaceRef.current = librarySurface;
  }, [librarySurface]);
  const statusRefreshInFlight = useRef(false);
  const lastCatalogModeRef = useRef<CatalogSyncMode>("newest");
  const lastProgressUiAt = useRef(0);

  const refreshFolderSync = useCallback(async () => {
    try {
      const next = await getFolderSyncState();
      setFolderSync(next);
    } catch {
      /* Sync page can still show creation status */
    }
  }, []);

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
    void (async () => {
      try {
        const [page, sync] = await Promise.all([
          listCreationsPage({ limit: CREATIONS_PAGE_SIZE, offset: 0 }),
          getSyncStatus(),
        ]);
        if (cancelled) return;
        offsetRef.current = page.creations.length;
        creationsRef.current = page.creations;
        setCreations(page.creations);
        setTotal(page.total);
        setHasMore(page.hasMore);
        setStatus(sync);
        setError(null);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setCreations([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadInitial]);

  useEffect(() => {
    const onReload = () => {
      void loadInitial();
      void refreshFolderSync();
    };
    window.addEventListener("parascene-library-reload", onReload);
    let off: (() => void) | undefined;
    void listen("library-catalog-reload", onReload).then((fn) => {
      off = fn;
    });
    return () => {
      window.removeEventListener("parascene-library-reload", onReload);
      off?.();
    };
  }, [loadInitial, refreshFolderSync]);

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
      if (statusRefreshInFlight.current) return;
      statusRefreshInFlight.current = true;
      void getSyncStatus()
        .then(setStatus)
        .catch(() => {})
        .finally(() => {
          statusRefreshInFlight.current = false;
        });
    };

    void listen<DownloadProgress>("library-download-progress", (event) => {
      setProgress(event.payload);
      if (
        event.payload.total > 0 &&
        event.payload.done >= event.payload.total
      ) {
        setCachingKind((prev) => {
          if (prev === "thumbs" && event.payload.phase === "thumbs") return null;
          if (prev === "media" && event.payload.phase === "media") return null;
          return prev;
        });
      }
      // Sync tab doesn't need per-tick SQLite status; settle once downloads quiet.
      if (surfaceRef.current !== "sync") {
        refreshStatus();
      }
      window.clearTimeout(statusRefreshTimer);
      // Settle counts shortly after the last progress tick.
      statusRefreshTimer = window.setTimeout(() => {
        if (statusRefreshInFlight.current) return;
        statusRefreshInFlight.current = true;
        void getSyncStatus()
          .then(setStatus)
          .catch(() => {})
          .finally(() => {
            statusRefreshInFlight.current = false;
          });
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
      // Sync surface doesn't mount the board — skip React list rewrites there.
      if (surfaceRef.current !== "sync") {
        setCreations(merged);
      }
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

  const runFolderSync = useCallback(
    async (opts?: {
      resolutions?: Record<string, "local" | "cloud">;
      priorConflicts?: FolderConflict[];
    }) => {
      const folderResult = await syncProjectFolders(opts);
      setFolderSyncResult(folderResult);
      if (folderResult.conflicts.length > 0) {
        setFolderConflicts(folderResult.conflicts);
        setFolderResolutions((prev) => {
          const next = { ...prev };
          for (const conflict of folderResult.conflicts) {
            if (!next[conflict.id]) next[conflict.id] = "local";
          }
          return next;
        });
      } else {
        setFolderConflicts([]);
        setFolderResolutions({});
      }
      await refreshFolderSync();
      return folderResult;
    },
    [refreshFolderSync, syncProjectFolders],
  );

  const pushActivity = useCallback((event: SyncItemEvent) => {
    setActivity((prev) => applySyncItemEvent(prev, event));
  }, []);

  const runCatalogSync = useCallback(
    async (mode: CatalogSyncMode) => {
      const jobId = `${mode}-${Date.now()}`;
      const title = mode === "newest" ? "Sync newest" : "Sync full catalog";
      const newestTarget = NEWEST_SYNC_PAGE_SIZE * NEWEST_SYNC_MAX_PAGES;
      lastCatalogModeRef.current = mode;
      lastProgressUiAt.current = 0;
      setSyncing(true);
      setCatalogSyncMode(mode);
      setError(null);
      setFolderSyncResult(null);
      // Paint immediately — don't wait for the first network round-trip.
      setSyncHeadline(
        mode === "newest"
          ? "Starting Sync newest…"
          : "Starting Sync full catalog…",
      );
      setProgress({
        done: 0,
        total: mode === "newest" ? newestTarget : 0,
        currentId:
          mode === "newest"
            ? "Starting Sync newest…"
            : "Starting Sync full catalog…",
        failed: 0,
        phase: "catalog",
      });
      pushActivity({
        id: jobId,
        kind: "catalog",
        state: "active",
        title,
        detail: mode === "newest" ? "Starting…" : "Starting full catalog…",
      });
      // Let React commit the Working state before auth/network work.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      try {
        const beforeTotal = status?.total ?? 0;
        const syncResult =
          mode === "newest"
            ? await (async () => {
                try {
                  await syncSessionUserAvatar();
                } catch {
                  /* avatar is best-effort before catalog work */
                }
                const result = await runSyncNewest({
                  onProgress: (p) => {
                    const now = Date.now();
                    const isTerminal = p.phase === "done";
                    if (!isTerminal && now - lastProgressUiAt.current < 200) {
                      return;
                    }
                    lastProgressUiAt.current = now;
                    setSyncHeadline(p.message);
                    setProgress({
                      done: p.checked ?? 0,
                      total: p.target ?? newestTarget,
                      currentId: p.message,
                      failed: 0,
                      phase: "catalog",
                    });
                    pushActivity({
                      id: jobId,
                      kind: "catalog",
                      state: "active",
                      title,
                      detail: p.message,
                    });
                  },
                });
                return result;
              })()
            : await (async () => {
                try {
                  await syncSessionUserAvatar();
                } catch {
                  /* avatar is best-effort before catalog work */
                }
                const result = await runSyncFull({
                  onProgress: (p) => {
                    const now = Date.now();
                    if (now - lastProgressUiAt.current < 200) return;
                    lastProgressUiAt.current = now;
                    setSyncHeadline(p.message);
                    setProgress({
                      done: p.checked ?? 0,
                      total: p.checked ?? 0,
                      currentId: p.message,
                      failed: 0,
                      phase: "catalog",
                    });
                    pushActivity({
                      id: jobId,
                      kind: "catalog",
                      state: "active",
                      title,
                      detail: p.message,
                    });
                  },
                });
                return result;
              })();
        const next = syncResult.status;
        setStatus(next);

        const added = Math.max(0, syncResult.added ?? next.total - beforeTotal);
        const pruned = mode === "newest" && "pruned" in syncResult ? syncResult.pruned : 0;
        const detail =
          mode === "newest"
            ? [
                added > 0
                  ? `Added ${added.toLocaleString()} creation(s)`
                  : "No new creations",
                pruned > 0
                  ? `removed ${pruned.toLocaleString()} deleted locally`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : `Catalog refreshed (${next.total.toLocaleString()} creations).`;
        pushActivity({
          id: jobId,
          kind: "catalog",
          state: "done",
          title,
          detail,
        });

        // Unlock Sync newest / Full immediately — folders are a separate step.
        // Refresh the Creations board in the background (don't block Sync).
        setSyncing(false);
        setCatalogSyncMode(null);
        setProgress(null);
        void loadInitial().catch(() => {});
        setSyncHeadline("Updating folders…");

        const folderJobId = `folders-${Date.now()}`;
        setFolderSyncing(true);
        pushActivity({
          id: folderJobId,
          kind: "folders",
          state: "active",
          title: "Sync folders",
          detail: "Pulling cloud folders…",
        });
        try {
          const folderResult = await runFolderSync();
          await refreshFolderSync();
          pushActivity({
            id: folderJobId,
            kind: "folders",
            state: folderResult.ok ? "done" : "failed",
            title: "Sync folders",
            detail: folderResult.ok
              ? folderResult.unavailable
                ? "Cloud folders unavailable"
                : "Folders up to date"
              : folderResult.message || "Folder sync failed",
          });
          if (
            !folderResult.ok &&
            folderResult.message &&
            folderResult.conflicts.length === 0
          ) {
            setError(folderResult.message);
          }

          // Pull project cabinets/folder groups into project.creationIds so
          // web-side group/folder edits show up without a manual re-add.
          setSyncHeadline("Updating projects…");
          const projectJobId = `projects-${Date.now()}`;
          pushActivity({
            id: projectJobId,
            kind: "catalog",
            state: "active",
            title: "Update projects",
            detail: "Merging group and folder members…",
          });
          try {
            const merged = await reconcileProjectsAfterLibrarySync({
              refreshCoversFromList: mode === "newest",
            });
            const detailParts = [
              merged.creationsRemoved > 0
                ? `removed ${merged.creationsRemoved.toLocaleString()} expanded group member(s)`
                : null,
              merged.creationsMerged > 0
                ? `added ${merged.creationsMerged.toLocaleString()} creation(s)`
                : null,
            ].filter(Boolean);
            pushActivity({
              id: projectJobId,
              kind: "catalog",
              state: "done",
              title: "Update projects",
              detail:
                detailParts.length > 0
                  ? `${detailParts.join(" · ")} across ${merged.projectsUpdated.toLocaleString()} project(s)`
                  : "Projects already up to date",
            });
          } catch (projectError) {
            const message =
              projectError instanceof Error
                ? projectError.message
                : String(projectError);
            console.error(projectError);
            pushActivity({
              id: projectJobId,
              kind: "catalog",
              state: "failed",
              title: "Update projects",
              detail: message,
            });
          }
        } finally {
          setFolderSyncing(false);
        }
        setSyncHeadline(null);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        pushActivity({
          id: jobId,
          kind: "catalog",
          state: "failed",
          title,
          detail: message,
        });
        setSyncing(false);
        setCatalogSyncMode(null);
        setProgress(null);
        setSyncHeadline(null);
      }
    },
    [
      loadInitial,
      pushActivity,
      reconcileProjectsAfterLibrarySync,
      refreshFolderSync,
      runFolderSync,
      status?.total,
    ],
  );

  /** Empty-library onboarding: always full catalog path. */
  const runSync = useCallback(async () => {
    await runCatalogSync("full");
  }, [runCatalogSync]);

  const runNewestSync = useCallback(async () => {
    await runCatalogSync("newest");
  }, [runCatalogSync]);

  const runFullSync = useCallback(async () => {
    await runCatalogSync("full");
  }, [runCatalogSync]);

  /** After browser reconnect — retry the catalog mode that last failed/ran. */
  const retryLastCatalogSync = useCallback(async () => {
    await runCatalogSync(lastCatalogModeRef.current);
  }, [runCatalogSync]);

  const runFolderOnlySync = useCallback(async () => {
    const folderJobId = `folders-${Date.now()}`;
    setFolderSyncing(true);
    setError(null);
    setFolderSyncResult(null);
    setSyncHeadline("Updating folders…");
    pushActivity({
      id: folderJobId,
      kind: "folders",
      state: "active",
      title: "Sync folders",
      detail: "Pulling cloud folders…",
    });
    try {
      const folderResult = await runFolderSync();
      pushActivity({
        id: folderJobId,
        kind: "folders",
        state: folderResult.ok ? "done" : "failed",
        title: "Sync folders",
        detail: folderResult.ok
          ? folderResult.unavailable
            ? "Cloud folders unavailable"
            : "Folders up to date"
          : folderResult.message || "Folder sync failed",
      });
      if (
        !folderResult.ok &&
        folderResult.message &&
        folderResult.conflicts.length === 0
      ) {
        setError(folderResult.message);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      pushActivity({
        id: folderJobId,
        kind: "folders",
        state: "failed",
        title: "Sync folders",
        detail: message,
      });
    } finally {
      setFolderSyncing(false);
      setSyncHeadline(null);
    }
  }, [pushActivity, runFolderSync]);

  const runResolveFolderConflicts = useCallback(async () => {
    if (folderConflicts.length === 0) return;
    const missing = folderConflicts.some((c) => !folderResolutions[c.id]);
    if (missing) return;
    setResolvingFolders(true);
    setError(null);
    try {
      const folderResult = await runFolderSync({
        resolutions: folderResolutions,
        priorConflicts: folderConflicts,
      });
      await loadInitial();
      if (!folderResult.ok && folderResult.conflicts.length === 0 && folderResult.message) {
        setError(folderResult.message);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolvingFolders(false);
    }
  }, [
    folderConflicts,
    folderResolutions,
    loadInitial,
    runFolderSync,
  ]);

  const runCacheThumbs = useCallback(async () => {
    const expected = status?.missingThumbCacheable ?? 0;
    const jobId = `cache-thumbs-${Date.now()}`;
    setError(null);
    setCachingKind("thumbs");
    setProgress({
      done: 0,
      total: expected,
      currentId: null,
      failed: 0,
      phase: "thumbs",
    });
    pushActivity({
      id: jobId,
      kind: "cache",
      state: "active",
      title: "Cache previews",
      detail:
        expected > 0
          ? `Queuing ${expected.toLocaleString()} preview(s)…`
          : "Checking…",
    });
    try {
      const summary = await cacheMissingThumbs();
      setStatus(summary.status);
      const queued = summary.skipped;
      if (queued === 0 && summary.downloaded === 0) {
        setProgress(null);
        setCachingKind(null);
        pushActivity({
          id: jobId,
          kind: "cache",
          state: "done",
          title: "Cache previews",
          detail: "Nothing to cache",
        });
        return;
      }
      setProgress({
        done: 0,
        total: queued,
        currentId: null,
        failed: 0,
        phase: "thumbs",
      });
      pushActivity({
        id: jobId,
        kind: "cache",
        state: "done",
        title: "Cache previews",
        detail: `Queued ${queued.toLocaleString()} preview(s)`,
      });
    } catch (e: unknown) {
      setCachingKind(null);
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
      pushActivity({
        id: jobId,
        kind: "cache",
        state: "failed",
        title: "Cache previews",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }, [pushActivity, setCachingKind, status?.missingThumbCacheable]);

  const runCacheMedia = useCallback(async () => {
    const expected = status?.missingMediaCacheable ?? 0;
    const jobId = `cache-media-${Date.now()}`;
    setError(null);
    setCachingKind("media");
    setProgress({
      done: 0,
      total: expected,
      currentId: null,
      failed: 0,
      phase: "media",
    });
    pushActivity({
      id: jobId,
      kind: "cache",
      state: "active",
      title: "Cache media",
      detail:
        expected > 0
          ? `Queuing ${expected.toLocaleString()} file(s)…`
          : "Checking…",
    });
    try {
      const summary = await cacheMissingMedia();
      setStatus(summary.status);
      const queued = summary.skipped;
      if (queued === 0 && summary.downloaded === 0) {
        setProgress(null);
        setCachingKind(null);
        pushActivity({
          id: jobId,
          kind: "cache",
          state: "done",
          title: "Cache media",
          detail: "Nothing to cache",
        });
        return;
      }
      setProgress({
        done: 0,
        total: queued,
        currentId: null,
        failed: 0,
        phase: "media",
      });
      pushActivity({
        id: jobId,
        kind: "cache",
        state: "done",
        title: "Cache media",
        detail: `Queued ${queued.toLocaleString()} file(s)`,
      });
    } catch (e: unknown) {
      setCachingKind(null);
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
      pushActivity({
        id: jobId,
        kind: "cache",
        state: "failed",
        title: "Cache media",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }, [pushActivity, setCachingKind, status?.missingMediaCacheable]);

  const runGroupMembersSync = useCallback(async () => {
    const jobId = `groups-${Date.now()}`;
    setSyncingGroups(true);
    setError(null);
    setSyncHeadline("Syncing group members…");
    setProgress({
      done: 0,
      total: 0,
      currentId: "Expanding group members…",
      failed: 0,
      phase: "catalog",
    });
    pushActivity({
      id: jobId,
      kind: "catalog",
      state: "active",
      title: "Sync group members",
      detail: "Reading local group covers…",
    });
    try {
      const result = await syncGroupMembersManifest();
      setStatus(result.status);
      const detail =
        result.added > 0
          ? `Added ${result.added.toLocaleString()} member(s) from ${result.groups.toLocaleString()} group(s)`
          : result.groups > 0
            ? `No new members (${result.groups.toLocaleString()} group(s) already complete)`
            : "No local groups to expand";
      pushActivity({
        id: jobId,
        kind: "catalog",
        state: "done",
        title: "Sync group members",
        detail,
      });
      void loadInitial().catch(() => {});
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      pushActivity({
        id: jobId,
        kind: "catalog",
        state: "failed",
        title: "Sync group members",
        detail: message,
      });
    } finally {
      setSyncingGroups(false);
      setSyncHeadline(null);
      setProgress(null);
    }
  }, [loadInitial, pushActivity]);

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
      const summary = await runCloudRepairService({
        onProgress: (p) => {
          const note = p.message;
          setProgress({
            done: 0,
            total: 0,
            currentId: note,
            failed: 0,
            phase:
              note.toLowerCase().includes("preview") ||
              note.toLowerCase().includes("thumb")
                ? "thumbs"
                : "repair",
          });
        },
        onItem: (event) => {
          setActivity((prev) => applySyncItemEvent(prev, event));
        },
      });
      setStatus(summary.status);
      await loadInitial();
      if (
        summary.groupUpdated === 0 &&
        summary.fitUpdated === 0 &&
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
    if (statusRefreshInFlight.current) return;
    statusRefreshInFlight.current = true;
    void getSyncStatus()
      .then(setStatus)
      .catch(() => {})
      .finally(() => {
        statusRefreshInFlight.current = false;
      });
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
    catalogSyncMode,
    repairing,
    loadingMore,
    importing,
    progress,
    activity,
    syncHeadline,
    cachingKind,
    syncingGroups,
    folderSync,
    folderSyncResult,
    folderConflicts,
    folderResolutions,
    setFolderResolutions,
    folderSyncing,
    resolvingFolders,
    runSync,
    runNewestSync,
    runFullSync,
    runGroupMembersSync,
    retryLastCatalogSync,
    runFolderOnlySync,
    runResolveFolderConflicts,
    runCacheThumbs,
    runCacheMedia,
    runCloudRepair,
    runImportFromDisk,
    clearFinishedActivity,
    clearError: () => setError(null),
    loadMore,
    refreshStatus,
    refreshFolderSync,
  };
}

function creationsChromeStatus(opts: {
  creations: Creation[] | null;
  visibleCount: number;
  filterActive: boolean;
  total: number;
}): string | null {
  const { creations, visibleCount, filterActive, total } = opts;
  if (creations === null) return "Loading catalog…";
  if (creations.length === 0) return null;
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
  progress,
  onSync,
  onLoadMore,
  onImportFromDisk,
  importing,
  seedFolders = [],
  surfaceActive = true,
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
  /** Cached folder rows (e.g. from sync state) for placeholders while listFolders runs. */
  seedFolders?: LibraryFolder[];
  /** False while Sync is focused — keep mounted but don't drive chrome status. */
  surfaceActive?: boolean;
}) {
  const {
    setChromeStatus,
    openProjectId,
    recentProjects,
    project,
    createProject,
    addCreationsToProject,
    removeCreationsFromProject,
    deleteLibraryCreation,
    releaseOrphanFolder,
    creationsFilterId,
    setCreationsFilterId,
    setOpenProjectGroupIds,
  } = useShell();
  const confirm = useConfirm();
  const [active, setActive] = useState<Creation | null>(null);

  const deleteCreationFromLibrary = useCallback(
    async (creationId: string) => {
      await deleteLibraryCreation(creationId);
    },
    [deleteLibraryCreation],
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Prefer sync-cached folders so remount/first paint can reserve folder slots.
  const [folders, setFolders] = useState<LibraryFolder[]>(() => seedFolders);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [filedIds, setFiledIds] = useState<Set<string>>(() => new Set());
  const [groupMemberIds, setGroupMemberIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [folderViewId, setFolderViewId] = useState<string | null>(null);
  /** Members loaded by id — not the paginated home catalog. */
  const [folderMembers, setFolderMembers] = useState<Creation[] | null>(null);
  const [folderMembersLoading, setFolderMembersLoading] = useState(false);
  /** Member rows used to decide which folders match the active filter. */
  const [folderFilterMembersById, setFolderFilterMembersById] = useState<
    Map<string, Creation>
  >(() => new Map());
  // Honor the stored filter immediately — don't paint unfiltered folders first.
  const [folderFilterMembersLoading, setFolderFilterMembersLoading] =
    useState(() =>
      folderNeedsMemberCreations(togglesFromFilterId(creationsFilterId)),
    );
  /** Membership snapshot last successfully loaded for the home folder filter. */
  const [folderFilterFetchedKey, setFolderFilterFetchedKey] = useState("");
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [pickFolderOpen, setPickFolderOpen] = useState(false);
  const [editFolder, setEditFolder] = useState<LibraryFolder | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{
    folder: LibraryFolder;
    x: number;
    y: number;
  } | null>(null);
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
  useEffect(() => {
    sidebarFiltersRef.current = sidebarFilters;
  }, [sidebarFilters]);
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
  const localProjectIds = useMemo(
    () => new Set(recentProjects.map((recent) => recent.id)),
    [recentProjects],
  );
  const [deferredKeepIds, setDeferredKeepIds] = useState<Set<string>>(
    () => new Set(),
  );
  const empty =
    creations !== null &&
    creations.length === 0 &&
    folders.length === 0 &&
    seedFolders.length === 0 &&
    !foldersLoading;

  // While the first folder fetch is in flight, adopt sync-cached rows for placeholders.
  if (foldersLoading && folders.length === 0 && seedFolders.length > 0) {
    setFolders(seedFolders);
  }

  const refreshFolders = useCallback(async () => {
    try {
      const [nextFolders, filed, groupMembers] = await Promise.all([
        listFolders(),
        listFiledCreationIds(),
        listGroupMemberIds(),
      ]);
      setFolders(nextFolders);
      setFiledIds(new Set(filed));
      setGroupMemberIds(new Set(groupMembers));
      setFolderViewId((current) => {
        if (!current) return null;
        return nextFolders.some((folder) => folder.id === current)
          ? current
          : null;
      });
    } catch (error) {
      console.error("Failed to load folders", error);
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextFolders, filed, groupMembers] = await Promise.all([
          listFolders(),
          listFiledCreationIds(),
          listGroupMemberIds(),
        ]);
        if (cancelled) return;
        setFolders(nextFolders);
        setFiledIds(new Set(filed));
        setGroupMemberIds(new Set(groupMembers));
        setFolderViewId((current) => {
          if (!current) return null;
          return nextFolders.some((folder) => folder.id === current)
            ? current
            : null;
        });
      } catch (error) {
        console.error("Failed to load folders", error);
      } finally {
        if (!cancelled) setFoldersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshFolders, creations?.length, total]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<LibraryFolder[]>("library-folders-updated", () => {
      void refreshFolders();
    }).then((off) => {
      unlisten = off;
    });
    return () => {
      unlisten?.();
    };
  }, [refreshFolders]);

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

  if (folderView || !needsFolderMemberFilter) {
    if (folderFilterMembersLoading) setFolderFilterMembersLoading(false);
    if (folderFilterFetchedKey !== "") setFolderFilterFetchedKey("");
  } else if (folders.length === 0 && !foldersLoading) {
    if (folderFilterMembersById.size > 0) {
      setFolderFilterMembersById(new Map());
    }
    if (folderFilterMembersLoading) setFolderFilterMembersLoading(false);
    if (folderFilterFetchedKey !== "") setFolderFilterFetchedKey("");
  } else if (
    needsFolderMemberFilter &&
    folders.length > 0 &&
    folderFilterFetchedKey !== homeFolderMemberIdsKey &&
    !folderFilterMembersLoading
  ) {
    // Folders arrived / changed before the effect — hold filtered board.
    setFolderFilterMembersLoading(true);
  }

  useEffect(() => {
    if (folderView || !needsFolderMemberFilter) return;
    if (folders.length === 0) {
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
      setFolderFilterFetchedKey(fetchKey);
      setFolderFilterMembersLoading(false);
    };

    // Same membership snapshot already loaded — avoid setState churn / loops.
    if (folderFilterFetchedKey === fetchKey) {
      return;
    }

    const missing = ids.filter((id) => !cache.has(id));
    if (missing.length === 0) {
      publishFromCache();
      return;
    }

    let cancelled = false;
    // Mark loading before the network round-trip so we never paint unfiltered folders.
    if (cache.size === 0 || missing.length > 0) {
      setFolderFilterMembersLoading(true);
    }

    void getCreations(missing)
      .then((rows) => {
        if (cancelled) return;
        for (const row of rows) cache.set(row.id, row);
        publishFromCache();
      })
      .catch((error) => {
        console.error("Failed to load folder members for filter", error);
        if (cancelled) return;
        setFolderFilterFetchedKey("");
        setFolderFilterMembersLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    folderFilterFetchedKey,
    folderView,
    folders,
    homeFolderMemberIdsKey,
    needsFolderMemberFilter,
  ]);

  if (!folderView) {
    if (folderMembers !== null) setFolderMembers(null);
    if (folderMembersLoading) setFolderMembersLoading(false);
  }

  useEffect(() => {
    if (!folderView) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setFolderMembersLoading(true);
    });
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
    return new Set(
      folders
        .filter((folder) => folder.projectId === openProjectId)
        .map((folder) => folder.id),
    );
  }, [folders, openProjectId]);

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
  const catalogListFilter = isCatalogListFilterId(gridFilterKey)
    ? gridFilterKey
    : null;

  /** Full SQLite match set when Audio / Local-only is active. */
  const [catalogFilterBundle, setCatalogFilterBundle] = useState<{
    filter: "audio" | "localOnly";
    rows: Creation[];
  } | null>(null);
  /** Local-only rows merged into All so buried unfiled imports stay visible. */
  const [localOnlyForAll, setLocalOnlyForAll] = useState<Creation[]>([]);

  useEffect(() => {
    if (!catalogListFilter) return;
    let cancelled = false;
    void listCreationsForFilter(catalogListFilter)
      .then((rows) => {
        if (!cancelled) {
          setCatalogFilterBundle({ filter: catalogListFilter, rows });
        }
      })
      .catch((error) => {
        console.error("Failed to list filter creations", error);
        if (!cancelled) {
          setCatalogFilterBundle({ filter: catalogListFilter, rows: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalogListFilter, total, creations?.length]);

  useEffect(() => {
    if (folderView || catalogListFilter) return;
    let cancelled = false;
    void listCreationsForFilter("localOnly")
      .then((rows) => {
        if (!cancelled) setLocalOnlyForAll(rows);
      })
      .catch((error) => {
        console.error("Failed to list local-only creations for All", error);
        if (!cancelled) setLocalOnlyForAll([]);
      });
    return () => {
      cancelled = true;
    };
  }, [folderView, catalogListFilter, total, creations?.length]);

  const catalogFilterCreations =
    catalogListFilter && catalogFilterBundle?.filter === catalogListFilter
      ? catalogFilterBundle.rows
      : null;

  // Any sidebar filter change reconciles deferred dims (Selected / Not selected pins).
  const [deferredFilterKey, setDeferredFilterKey] = useState(sidebarFilterKey);
  if (sidebarFilterKey !== deferredFilterKey) {
    setDeferredFilterKey(sidebarFilterKey);
    setDeferredKeepIds(new Set());
  }

  // Drop In project filter when the project closes.
  if (
    !openProjectId &&
    (sidebarFilterKey === "inProject" || gridFilterKey === "inProject")
  ) {
    setSidebarFilters(EMPTY_FILTER_TOGGLES);
    setGridFilters(EMPTY_FILTER_TOGGLES);
    setGridBlank(false);
    setCreationsFilterId("all");
  }

  useEffect(() => {
    return () => {
      filterApplyGen.current += 1;
    };
  }, []);

  const boardCreations = useMemo(() => {
    if (!creations) return null;
    if (catalogListFilter) return catalogFilterCreations;
    return mergeCreationsById(creations, localOnlyForAll);
  }, [
    catalogFilterCreations,
    catalogListFilter,
    creations,
    localOnlyForAll,
  ]);

  const visibleCreations = useMemo(() => {
    if (gridBlank || !boardCreations) return [];
    if (folderView) {
      if (!folderMembers) return [];
      // Covers stay; members browse inside the group — don't litter the folder.
      const nested = omitFolderMembersHiddenByCovers(folderMembers);
      return filterCreationsVisible(
        nested,
        gridFilters,
        selectedIds,
        deferredKeepIds,
        inProjectIds,
      );
    }
    const unfiled = omitGroupMemberCreations(
      omitFiledCreations(boardCreations, filedIds),
      groupMemberIds,
    );
    return filterCreationsVisible(
      unfiled,
      gridFilters,
      selectedIds,
      deferredKeepIds,
      inProjectIds,
      groupMemberIds,
    );
  }, [
    boardCreations,
    deferredKeepIds,
    filedIds,
    folderMembers,
    folderView,
    gridBlank,
    gridFilters,
    groupMemberIds,
    inProjectIds,
    selectedIds,
  ]);

  const folderFilterCreationsById = useMemo(() => {
    const map = new Map<string, Creation>(folderFilterMembersById);
    for (const creation of boardCreations ?? creations ?? []) {
      if (!map.has(creation.id)) map.set(creation.id, creation);
    }
    return map;
  }, [boardCreations, creations, folderFilterMembersById]);

  const libraryCreationsById = useMemo(() => {
    const map: Record<string, Creation> = {};
    const ingest = (list: Creation[] | null | undefined) => {
      for (const creation of list ?? []) {
        map[creation.id] = creation;
      }
    };
    ingest(boardCreations);
    ingest(folderMembers);
    ingest(creations);
    for (const creation of folderFilterMembersById.values()) {
      map[creation.id] = creation;
    }
    return map;
  }, [boardCreations, creations, folderFilterMembersById, folderMembers]);

  const groupMembershipByMemberId = useMemo(
    () => buildGroupMembershipByMemberId(libraryCreationsById),
    [libraryCreationsById],
  );

  const groupAddTargetForSelection = useMemo(() => {
    if (selectedIds.size === 0) return null;
    return resolveLibraryGroupAddTarget({
      assetIds: [...selectedIds],
      groupMembershipByMemberId,
      creationsById: libraryCreationsById,
    });
  }, [
    groupMembershipByMemberId,
    libraryCreationsById,
    selectedIds,
  ]);

  const addToGroupLabel = groupAddTargetForSelection
    ? `Add to group${
        groupAddTargetForSelection.memberIds.length > 1
          ? ` (${groupAddTargetForSelection.memberIds.length})`
          : ""
      }`
    : null;

  const addToGroupTitle = groupAddTargetForSelection
    ? `Add selected ${groupAddTargetForSelection.memberMediaKind}s to “${groupAddTargetForSelection.groupLabel}”. Include the group cover or a member in the selection.`
    : null;

  const onAddSelectionToGroup = useCallback(() => {
    const target = groupAddTargetForSelection;
    if (!target) return;
    const count = target.memberIds.length;
    const cover = libraryCreationsById[target.groupId] ?? null;
    void confirm({
      title:
        count === 1
          ? `Add to group?`
          : `Add ${count} to group?`,
      message:
        count === 1
          ? `This will add the selected ${target.memberMediaKind} to “${target.groupLabel}” on Parascene.`
          : `This will add ${count} selected ${target.memberMediaKind}s to “${target.groupLabel}” on Parascene.`,
      confirmLabel: "Add to group",
      cancelLabel: "Cancel",
      errorTitle: "Could not add to group",
      onConfirm: async ({ setMessage }) => {
        setMessage("Starting…");
        const result = await appendMembersToGroupCover({
          groupId: target.groupId,
          memberIds: target.memberIds,
          onProgress: setMessage,
        });
        await followUpDesktopCabinetGroupAppend({
          groupId: result.groupId,
          cover,
          onProgress: setMessage,
        });
        const cabinet = cover
          ? identifyDesktopCabinet(cover)?.projectId?.trim()
          : null;
        if (cabinet && cabinet === openProjectId) {
          await addCreationsToProject(cabinet, [result.groupId]);
          const kind = identifyDesktopCabinet(cover)?.role;
          if (kind === "project_images") {
            setOpenProjectGroupIds({ imagesGroupId: result.groupId });
          } else if (kind === "project_videos") {
            setOpenProjectGroupIds({ videosGroupId: result.groupId });
          }
        }
        setSelectedIds(new Set());
        setDeferredKeepIds(new Set());
        await refreshFolders();
      },
    });
  }, [
    addCreationsToProject,
    confirm,
    groupAddTargetForSelection,
    libraryCreationsById,
    openProjectId,
    refreshFolders,
    setOpenProjectGroupIds,
  ]);

  const homeFolderAspect = useMemo(
    () => folderBoardAspect(gridFilters),
    [gridFilters],
  );

  const boardColumnLayout = useMemo(
    () => boardColumnLayoutForFilter(gridFilterKey) ?? undefined,
    [gridFilterKey],
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
        groupMemberIds,
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
    groupMemberIds,
    inProjectIds,
    needsFolderMemberFilter,
    projectFolderIds,
    selectedFolderIds,
    selectedIds,
  ]);

  const folderPlaceholders = folders.length > 0 ? folders : seedFolders;

  // Don't paint finished folder cards until list + (when needed) filter members are ready.
  const foldersPending =
    foldersLoading ||
    (needsFolderMemberFilter && folderFilterMembersLoading);

  const showFolderSkeletons =
    !folderView &&
    !gridBlank &&
    folderPlaceholders.length > 0 &&
    foldersPending;

  const boardFolders = showFolderSkeletons ? folderPlaceholders : homeFolders;

  const loadingFolderIds = useMemo(
    () =>
      showFolderSkeletons
        ? new Set(folderPlaceholders.map((folder) => folder.id))
        : undefined,
    [folderPlaceholders, showFolderSkeletons],
  );

  const folderCollageIdsByFolderId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const folder of boardFolders) {
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
          4,
          groupMemberIds,
        ),
      );
    }
    return map;
  }, [
    boardFolders,
    folderFilterCreationsById,
    gridFilters,
    groupMemberIds,
    inProjectIds,
    projectFolderIds,
    selectedFolderIds,
    selectedIds,
  ]);

  const folderMemberCountsByFolderId = useMemo(() => {
    const map = new Map<string, number>();
    for (const folder of boardFolders) {
      map.set(
        folder.id,
        folderFilteredMemberCount(
          folder,
          gridFilters,
          selectedIds,
          selectedFolderIds,
          inProjectIds,
          projectFolderIds,
          folderFilterCreationsById,
          groupMemberIds,
        ),
      );
    }
    return map;
  }, [
    boardFolders,
    folderFilterCreationsById,
    gridFilters,
    groupMemberIds,
    inProjectIds,
    projectFolderIds,
    selectedFolderIds,
    selectedIds,
  ]);

  const catalogFilterLoading =
    Boolean(catalogListFilter) && catalogFilterCreations === null;

  const filterEmpty =
    !gridBlank &&
    !folderMembersLoading &&
    !catalogFilterLoading &&
    !(folderFilterMembersLoading && needsFolderMemberFilter && !showFolderSkeletons) &&
    visibleCreations.length === 0 &&
    boardFolders.length === 0;
  const [showFilterEmpty, setShowFilterEmpty] = useState(false);
  if (!filterEmpty && showFilterEmpty) {
    setShowFilterEmpty(false);
  }
  useEffect(() => {
    if (!filterEmpty) return;
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

  const pickableFolders = useMemo(
    () =>
      folders.filter(
        (folder) =>
          folder.kind === "regular" ||
          (folder.kind === "project" &&
            Boolean(folder.projectId) &&
            localProjectIds.has(folder.projectId as string)),
      ),
    [folders, localProjectIds],
  );

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
        if (folder.kind === "project") {
          if (!folder.projectId) return;
          const result = await addCreationsToProject(folder.projectId, [
            ...selectedIds,
          ]);
          if (!result) return;
        } else {
          await addToFolder(folder.id, [...selectedIds]);
        }
        setPickFolderOpen(false);
        setSelectedIds(new Set());
        setDeferredKeepIds(new Set());
        await refreshFolders();
      } catch (error) {
        if (folder.kind === "project") {
          window.alert(error instanceof Error ? error.message : String(error));
        } else {
          console.error(error);
        }
      }
    },
    [addCreationsToProject, refreshFolders, selectedIds],
  );

  const onRemoveSelectionFromFolder = useCallback(async () => {
    if (selectedIds.size === 0) return;
    try {
      const ids = [...selectedIds];
      if (folderView?.kind === "project" && folderView.projectId) {
        await removeCreationsFromProject(folderView.projectId, ids);
      } else {
        await removeFromFolder(ids);
      }
      setSelectedIds(new Set());
      setDeferredKeepIds(new Set());
      await refreshFolders();
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }, [folderView, refreshFolders, removeCreationsFromProject, selectedIds]);

  const onSetFolderCoverFromLightbox = useCallback(
    async (creationId: string | null) => {
      if (!folderView) return;
      await setFolderCover(folderView.id, creationId);
      await refreshFolders();
    },
    [folderView, refreshFolders],
  );

  const onSaveFolderEdit = useCallback(
    async (title: string, description: string) => {
      if (!editFolder) return;
      if (editFolder.kind === "project") return;
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

  const selectedFolders = useMemo(
    () => folders.filter((folder) => selectedFolderIds.has(folder.id)),
    [folders, selectedFolderIds],
  );
  const canDeleteSelectedFolders =
    selectedFolderIds.size > 0 &&
    selectedFolders.length === selectedFolderIds.size &&
    selectedFolders.every(isEmptyRegularFolder);

  const onDeleteFolders = useCallback(
    async (targets: LibraryFolder[]) => {
      const unique = new Map(targets.map((folder) => [folder.id, folder]));
      const list = [...unique.values()];
      if (list.length === 0) return;

      const deletable = list.filter(isEmptyRegularFolder);
      if (deletable.length === 0) {
        const projectBlocked = list.some((folder) => folder.kind === "project");
        await confirm({
          title: list.length === 1 ? "Can't delete folder" : "Can't delete folders",
          message: projectBlocked
            ? "Project folders can only be removed by deleting their project."
            : "Only empty folders can be deleted. Remove the items first.",
          hideCancel: true,
          confirmLabel: "OK",
        });
        return;
      }

      const ok = await confirm({
        title: deletable.length === 1 ? "Delete folder?" : "Delete folders?",
        message:
          deletable.length === 1
            ? `Delete “${deletable[0].title}”? This folder is empty.`
            : `Delete ${deletable.length} empty folders?`,
        confirmLabel:
          deletable.length === 1 ? "Delete folder" : "Delete folders",
        danger: true,
        errorTitle: "Could not delete folder",
        onConfirm: async () => {
          const errors: string[] = [];
          for (const folder of deletable) {
            try {
              await deleteFolder(folder.id);
            } catch (error) {
              errors.push(
                `${folder.title}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          await refreshFolders();
          if (errors.length > 0) {
            throw new Error(errors.join("\n"));
          }
        },
      });
      if (!ok) return;
      const deletedIds = new Set(deletable.map((folder) => folder.id));
      setSelectedFolderIds((prev) => {
        const next = new Set(prev);
        for (const id of deletedIds) next.delete(id);
        return next;
      });
      setFolderViewId((current) =>
        current && deletedIds.has(current) ? null : current,
      );
      setFolderContextMenu(null);
    },
    [confirm, refreshFolders],
  );

  useEffect(() => {
    if (!folderContextMenu) return;
    const close = () => setFolderContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [folderContextMenu]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("input, textarea, select, [contenteditable='true']") ||
          target.isContentEditable)
      ) {
        return;
      }
      if (active || editFolder || createFolderOpen || pickFolderOpen) return;
      if (document.querySelector(".confirm-dialog")) return;
      if (selectedFolderIds.size === 0 || selectedIds.size > 0) return;
      event.preventDefault();
      void onDeleteFolders(selectedFolders);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    active,
    createFolderOpen,
    editFolder,
    onDeleteFolders,
    pickFolderOpen,
    selectedFolderIds.size,
    selectedFolders,
    selectedIds.size,
  ]);

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
    if (!surfaceActive) {
      return () => {};
    }
    if (gridBlank) {
      setChromeStatus(null);
      return () => setChromeStatus(null);
    }
    setChromeStatus(
      creationsChromeStatus({
        creations: boardCreations ?? creations,
        visibleCount: visibleCreations.length,
        filterActive: gridFilterKey !== "all",
        total: catalogListFilter
          ? (boardCreations?.length ?? total)
          : total,
      }),
    );
    return () => setChromeStatus(null);
  }, [
    surfaceActive,
    boardCreations,
    catalogListFilter,
    creations,
    gridBlank,
    gridFilterKey,
    setChromeStatus,
    total,
    visibleCreations.length,
  ]);

  return (
    <section className="stub-panel creations-panel" aria-label="Creations">
      {error ? <p className="library-error">{error}</p> : null}
      {creations === null ? (
        <LibraryPageSkeleton
          sidebarWidth={sidebarWidth}
          filterId={sidebarFilterKey}
        />
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
            hasOpenProject={folders.some(
              (folder) =>
                folder.kind === "project" &&
                Boolean(folder.projectId) &&
                localProjectIds.has(folder.projectId as string),
            )}
            inFolderView={Boolean(folderView)}
            folderViewLocked={Boolean(
              folderView?.kind === "project" &&
                (!folderView.projectId || !localProjectIds.has(folderView.projectId)),
            )}
            onReleaseOrphanFolder={
              folderView?.kind === "project" &&
              folderView.id &&
              (!folderView.projectId || !localProjectIds.has(folderView.projectId))
                ? () => {
                    void releaseOrphanFolder(folderView.id)
                      .then((released) => {
                        setFolders((prev) =>
                          prev.map((folder) =>
                            folder.id === released.id ? released : folder,
                          ),
                        );
                        setFolderViewId(released.id);
                      })
                      .catch((error) => {
                        const message =
                          error instanceof Error ? error.message : String(error);
                        setChromeStatus(`Could not release folder: ${message}`);
                      });
                  }
                : undefined
            }
            hasFolders={pickableFolders.length > 0 || seedFolders.length > 0}
            onNewProject={onNewProjectFromSelection}
            onNewFolder={() => setCreateFolderOpen(true)}
            onAddToFolder={() => setPickFolderOpen(true)}
            onAddToGroup={
              groupAddTargetForSelection ? onAddSelectionToGroup : undefined
            }
            addToGroupLabel={addToGroupLabel}
            addToGroupTitle={addToGroupTitle}
            onRemoveFromFolder={() => {
              void onRemoveSelectionFromFolder();
            }}
            onDeleteFolders={
              canDeleteSelectedFolders
                ? () => {
                    void onDeleteFolders(selectedFolders);
                  }
                : undefined
            }
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
                {folderView.kind === "regular" ? (
                  <>
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
                    {isEmptyRegularFolder(folderView) ? (
                      <button
                        type="button"
                        className="library-folder-edit"
                        aria-label="Delete folder"
                        onClick={() => {
                          void onDeleteFolders([folderView]);
                        }}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                          <path
                            fill="currentColor"
                            d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM6 7h12l-1 14H7L6 7z"
                          />
                        </svg>
                      </button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <span className="folder-project-badge">Project</span>
                  </>
                )}
              </div>
            ) : null}
            {gridBlank ||
            folderMembersLoading ||
            catalogFilterLoading ||
            (folderFilterMembersLoading &&
              needsFolderMemberFilter &&
              !showFolderSkeletons) ||
            (filterEmpty && !showFilterEmpty && boardFolders.length === 0) ? (
              <div
                className="creations-grid-blank"
                aria-busy={
                  gridBlank ||
                  folderMembersLoading ||
                  catalogFilterLoading ||
                  (folderFilterMembersLoading && needsFolderMemberFilter) ||
                  undefined
                }
              />
            ) : showFilterEmpty && boardFolders.length === 0 ? (
              folderView && folderView.memberCount === 0 ? (
                <FolderEmpty
                  title={folderView.title}
                  canDelete={isEmptyRegularFolder(folderView)}
                  onDelete={() => {
                    void onDeleteFolders([folderView]);
                  }}
                />
              ) : (
                <CreationsFilterEmpty />
              )
            ) : (
              <VirtualCreationsGrid
                creations={visibleCreations}
                folders={boardFolders}
                loadingFolderIds={loadingFolderIds}
                selectedIds={selectedIds}
                selectedFolderIds={selectedFolderIds}
                dimmedIds={dimmedIds}
                inProjectIds={inProjectIds}
                layoutResetKey={`${gridFilterKey}:${folderViewId ?? "home"}`}
                folderPackHeight={homeFolderAspect.packHeight}
                folderAspectCss={homeFolderAspect.aspectCss}
                folderCollageIdsByFolderId={folderCollageIdsByFolderId}
                folderMemberCountsByFolderId={folderMemberCountsByFolderId}
                folderCreationsById={folderFilterCreationsById}
                boardColumnLayout={boardColumnLayout}
                onOpen={(creation) => {
                  setActive(creation);
                }}
                onToggleSelect={onToggleSelect}
                onOpenFolder={(next) => {
                  setFolderViewId(next.id);
                  setSelectedIds(new Set());
                  setSelectedFolderIds(new Set());
                }}
                onToggleFolderSelect={onToggleFolderSelect}
                onFolderContextMenu={(folder, event) => {
                  setFolderContextMenu({
                    folder,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onNearEnd={() => {
                  if (catalogListFilter) return;
                  if (gridFilterKey === "selected") return;
                  if (folderView) return;
                  onLoadMore();
                }}
              />
            )}
            {active ? (
              <CreationLightbox
                creation={
                  (boardCreations ?? creations)?.find(
                    (c) => c.id === active.id,
                  ) ?? active
                }
                onClose={() => setActive(null)}
                deleteCreation={deleteCreationFromLibrary}
                onDeleted={() => setActive(null)}
                folderCover={
                  folderView
                    ? {
                        folderId: folderView.id,
                        folderKind: folderView.kind,
                        coverCreationId: folderView.coverCreationId ?? null,
                        onSetCover: onSetFolderCoverFromLightbox,
                      }
                    : null
                }
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
                folders={pickableFolders}
                creationsById={folderFilterCreationsById}
                selectedCount={selectedIds.size}
                onCancel={() => setPickFolderOpen(false)}
                onPick={(folder) => {
                  void onAddSelectionToFolder(folder);
                }}
              />
            ) : null}
            {editFolder?.kind === "regular" ? (
              <FolderEditModal
                folder={editFolder}
                entityKind="folder"
                onCancel={() => setEditFolder(null)}
                onSave={(title, description) => {
                  void onSaveFolderEdit(title, description);
                }}
              />
            ) : null}
            {folderContextMenu
              ? createPortal(
                  <div
                    className="library-folder-context-menu"
                    role="menu"
                    style={{
                      left: folderContextMenu.x,
                      top: folderContextMenu.y,
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.preventDefault()}
                  >
                    {folderContextMenu.folder.kind === "regular" ? (
                      <button
                        type="button"
                        className="library-folder-context-item"
                        role="menuitem"
                        onClick={() => {
                          const folder = folderContextMenu.folder;
                          setFolderContextMenu(null);
                          setEditFolder(folder);
                        }}
                      >
                        Edit folder
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="library-folder-context-item is-danger"
                      role="menuitem"
                      disabled={!isEmptyRegularFolder(folderContextMenu.folder)}
                      title={
                        folderContextMenu.folder.kind === "project"
                          ? "Project folders can only be removed by deleting their project."
                          : folderContextMenu.folder.memberCount > 0
                            ? "Remove the items first."
                            : undefined
                      }
                      onClick={() => {
                        const folder = folderContextMenu.folder;
                        setFolderContextMenu(null);
                        void onDeleteFolders([folder]);
                      }}
                    >
                      Delete folder
                    </button>
                  </div>,
                  document.body,
                )
              : null}
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
  catalogSyncMode,
  repairing,
  progress,
  activity,
  syncHeadline,
  cachingKind,
  syncingGroups,
  folderSync,
  folderSyncResult,
  folderConflicts,
  folderResolutions,
  onFolderResolution,
  onResolveFolderConflicts,
  folderSyncing,
  resolvingFolders,
  onNewestSync,
  onFullSync,
  onGroupMembersSync,
  onRetryAfterReauth,
  onFolderSync,
  onCacheThumbs,
  onCacheMedia,
  onCloudRepair,
  onClearFinished,
  onClearError,
  onRefreshStatus,
  onRefreshFolderSync,
}: {
  status: SyncStatus | null;
  error: string | null;
  syncing: boolean;
  catalogSyncMode: CatalogSyncMode | null;
  repairing: boolean;
  progress: DownloadProgress | null;
  activity: SyncActivityItem[];
  syncHeadline: string | null;
  cachingKind: "thumbs" | "media" | null;
  syncingGroups: boolean;
  folderSync: FolderSyncState | null;
  folderSyncResult: FolderSyncResult | null;
  folderConflicts: FolderConflict[];
  folderResolutions: Record<string, "local" | "cloud">;
  onFolderResolution: (conflictId: string, choice: "local" | "cloud") => void;
  onResolveFolderConflicts: () => void;
  folderSyncing: boolean;
  resolvingFolders: boolean;
  onNewestSync: () => void;
  onFullSync: () => void;
  onGroupMembersSync: () => void;
  onRetryAfterReauth: () => void;
  onFolderSync: () => void;
  onCacheThumbs: () => void;
  onCacheMedia: () => void;
  onCloudRepair: () => void;
  onClearFinished: () => void;
  onClearError: () => void;
  onRefreshStatus: () => void;
  onRefreshFolderSync: () => void;
}) {
  const { reauth } = useAuth();
  const [active, setActive] = useState<Creation | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const needsReauth = Boolean(error && isSessionReauthError(error));
  const folderPollTick = useRef(0);
  const backgroundCatalogJob = useBackgroundCatalogJob();
  const hadBackgroundCatalogJob = useRef(false);
  const backgroundCatalogMode = catalogJobMode(
    backgroundCatalogJob ? String(backgroundCatalogJob.kind) : "",
  );
  const backgroundCatalogLive =
    backgroundCatalogJob != null &&
    String(backgroundCatalogJob.status) !== "queued";

  useEffect(() => {
    if (hadBackgroundCatalogJob.current && !backgroundCatalogJob) {
      onRefreshStatus();
    }
    hadBackgroundCatalogJob.current = backgroundCatalogJob != null;
  }, [backgroundCatalogJob, onRefreshStatus]);

  useEffect(() => {
    onRefreshStatus();
    onRefreshFolderSync();
    // Idle Sync tab: slow poll. Active work: moderate — status is SQLite + cached disk size.
    const busy =
      syncing ||
      folderSyncing ||
      repairing ||
      syncingGroups ||
      cachingKind != null ||
      backgroundCatalogJob != null;
    const ms = busy ? 5_000 : 30_000;
    const id = window.setInterval(() => {
      onRefreshStatus();
      // Folders change rarely — refresh every other tick while idle.
      folderPollTick.current += 1;
      if (busy || folderPollTick.current % 2 === 0) {
        onRefreshFolderSync();
      }
    }, ms);
    return () => window.clearInterval(id);
  }, [
    folderSyncing,
    onRefreshFolderSync,
    onRefreshStatus,
    backgroundCatalogJob,
    repairing,
    syncing,
    syncingGroups,
    cachingKind,
  ]);

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
  const cachingThumbs = cachingKind === "thumbs";
  const cachingMedia = cachingKind === "media";
  const { jobs: jobItems, downloads: downloadItems } =
    partitionSyncActivity(activity);
  const liveDownloads = downloadItems.filter(
    (item) => item.state === "queued" || item.state === "active",
  );
  const failedDownloads = downloadItems.filter(
    (item) => item.state === "failed",
  );
  const folderPending = folderSync?.pendingOps.length ?? 0;
  const folderRevision =
    folderSync?.revision == null ? "—" : `rev ${folderSync.revision}`;
  const folderCount = folderSync?.folders.length ?? 0;
  const allConflictsResolved =
    folderConflicts.length > 0 &&
    folderConflicts.every((conflict) => folderResolutions[conflict.id]);

  const catalogLocked =
    syncing || repairing || syncingGroups || backgroundCatalogJob != null;
  const foldersLocked = folderSyncing || resolvingFolders || syncing;
  const cacheLocked =
    catalogLocked ||
    foldersLocked ||
    cachingThumbs ||
    cachingMedia ||
    (status?.downloading ?? 0) > 0;

  const liveHeadline =
    syncHeadline ||
    (repairing
      ? typeof progress?.currentId === "string" && progress.currentId
        ? progress.currentId
        : "Repairing library…"
      : cachingThumbs
        ? `Caching previews ${progress?.done ?? 0}/${progress?.total ?? 0}`
        : cachingMedia
          ? `Caching media ${progress?.done ?? 0}/${progress?.total ?? 0}`
          : liveDownloads.length > 0
            ? `Warming ${liveDownloads.length.toLocaleString()} file(s)…`
            : null);
  const backgroundHeadline = backgroundCatalogJob
    ? catalogJobHeadline(backgroundCatalogJob)
    : null;
  const heroLive = Boolean(liveHeadline || backgroundHeadline);

  const diskLabel = status ? syncDiskSummary(status) : "";
  const diskParts = diskLabel.split(" · ");

  return (
    <section className="stub-panel sync-panel" aria-label="Sync">
      {error ? (
        <div className="library-error-block" role="alert">
          <p className="library-error">{error}</p>
          {needsReauth ? (
            <button
              type="button"
              className="btn primary"
              disabled={reconnecting || syncing}
              onClick={() => {
                void (async () => {
                  setReconnecting(true);
                  try {
                    const ok = await reauth();
                    if (!ok) return;
                    onClearError();
                    // Reconnect used to only clear the banner — always retry Sync.
                    onRetryAfterReauth();
                  } finally {
                    setReconnecting(false);
                  }
                })();
              }}
            >
              {reconnecting ? "Reconnecting…" : "Reconnect & retry"}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={syncing || folderSyncing || repairing}
              onClick={() => {
                onClearError();
                onRetryAfterReauth();
              }}
            >
              Retry
            </button>
          )}
        </div>
      ) : null}
      {status === null && !error ? (
        <p className="muted">Loading sync status…</p>
      ) : null}
      {status ? (
        <div className="sync-body">
          <header className="sync-hero">
            <div
              className={`sync-now${heroLive ? " is-live" : ""}`}
              role="status"
              aria-live="polite"
            >
              {liveHeadline ? (
                <>
                  <span className="sync-status-pulse" aria-hidden />
                  <div className="sync-now-copy">
                    <p className="sync-now-label">Working</p>
                    <p className="sync-now-title">{liveHeadline}</p>
                    {syncing &&
                    progress?.phase === "catalog" &&
                    progress.total > 0 ? (
                      <>
                        <p className="sync-now-count muted">
                          {Math.min(progress.done, progress.total).toLocaleString()}{" "}
                          / {progress.total.toLocaleString()} newest
                        </p>
                        <div className="sync-progress-track" aria-hidden>
                          <div
                            className="sync-progress-fill"
                            style={{
                              width: `${Math.min(
                                100,
                                Math.round(
                                  (100 * progress.done) /
                                    Math.max(1, progress.total),
                                ),
                              )}%`,
                            }}
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                </>
              ) : backgroundHeadline ? (
                <>
                  <span className="sync-status-pulse" aria-hidden />
                  <div className="sync-now-copy">
                    <p className="sync-now-label">{backgroundHeadline.label}</p>
                    <p className="sync-now-title">{backgroundHeadline.title}</p>
                    <p className="sync-now-count muted">
                      {String(backgroundCatalogJob?.status) === "queued"
                        ? "Waiting for the jobs worker"
                        : backgroundCatalogMode === "full"
                          ? "Full catalog sync is already running"
                          : "Newest catalog sync is already running"}
                    </p>
                  </div>
                </>
              ) : (
                <div>
                  <p className="sync-now-label">Ready</p>
                  <p className="sync-now-title">
                    Last synced {formatLastSync(status.lastSyncAt)}
                  </p>
                </div>
              )}
            </div>
          </header>

          <div className="sync-sections">
            <section className="sync-section" aria-label="Catalog">
              <h3 className="sync-section-title">Catalog</h3>
              <p className="muted sync-section-help">
                Newest pulls ~100 latest creations and clears recent remote
                deletions. Sync full catalog refreshes every creation cover.
                Group members are separate — expand them after the catalog is
                current.
              </p>
              <div className="sync-section-actions">
                <CatalogSyncButton
                  mode="newest"
                  primary
                  active={
                    (syncing && catalogSyncMode === "newest") ||
                    (backgroundCatalogLive && backgroundCatalogMode === "newest")
                  }
                  disabled={catalogLocked}
                  onSync={onNewestSync}
                  progress={progress}
                />
                <CatalogSyncButton
                  mode="full"
                  active={
                    (syncing && catalogSyncMode === "full") ||
                    (backgroundCatalogLive && backgroundCatalogMode === "full")
                  }
                  disabled={catalogLocked}
                  onSync={onFullSync}
                  progress={progress}
                />
                <button
                  type="button"
                  className="btn ghost"
                  onClick={onGroupMembersSync}
                  disabled={catalogLocked}
                  title="Upsert members embedded in local group covers that are not standalone catalog rows yet"
                >
                  {syncingGroups ? "Syncing group members…" : "Sync group members"}
                </button>
              </div>
            </section>

            <section className="sync-section" aria-label="Library files">
              <h3 className="sync-section-title">Library</h3>
              <p className="muted sync-section-help">
                Folders and on-disk caches. Previews/media only download what is
                still missing.
              </p>
              <div className="sync-section-actions">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={onFolderSync}
                  disabled={foldersLocked}
                  title="Pull cloud folders and upload pending folder changes"
                >
                  {folderSyncing
                    ? "Syncing folders…"
                    : folderPending > 0
                      ? `Sync ${folderPending.toLocaleString()} folder change${folderPending === 1 ? "" : "s"}`
                      : "Sync folders"}
                </button>
                {cachingThumbs || missingThumbs > 0 ? (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={onCacheThumbs}
                    disabled={cacheLocked || (!cachingThumbs && missingThumbs === 0)}
                  >
                    {cachingThumbs
                      ? `Previews ${progress?.done ?? 0}/${progress?.total ?? 0}`
                      : `Cache ${missingThumbs.toLocaleString()} previews`}
                  </button>
                ) : (
                  <span
                    className="muted sync-cache-status"
                    title={
                      unsyncableThumbs > 0
                        ? "No downloadable preview URLs for the remaining items"
                        : "All cacheable previews are on disk"
                    }
                  >
                    {unsyncableThumbs > 0
                      ? "No cacheable previews"
                      : "Previews cached"}
                  </span>
                )}
                {cachingMedia || missingMedia > 0 ? (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={onCacheMedia}
                    disabled={cacheLocked || (!cachingMedia && missingMedia === 0)}
                  >
                    {cachingMedia
                      ? `Media ${progress?.done ?? 0}/${progress?.total ?? 0}`
                      : `Cache ${missingMedia.toLocaleString()} media`}
                  </button>
                ) : (
                  <span
                    className="muted sync-cache-status"
                    title={
                      unsyncableMedia > 0
                        ? "No downloadable media URLs for the remaining items"
                        : "All cacheable media is on disk"
                    }
                  >
                    {unsyncableMedia > 0
                      ? "No cacheable media"
                      : "Media cached"}
                  </span>
                )}
                <button
                  type="button"
                  className="btn ghost"
                  onClick={onCloudRepair}
                  disabled={catalogLocked || foldersLocked}
                  title="Rebuild mismatched thumbs and upload fit; Parascene only for leftovers"
                >
                  {repairing
                    ? typeof progress?.currentId === "string" &&
                      progress.currentId
                      ? progress.currentId
                      : "Repairing…"
                    : "Repair thumbs"}
                </button>
              </div>
            </section>
          </div>

          <dl className="sync-metrics" aria-label="Library summary">
            <div>
              <dt>Creations</dt>
              <dd>{status.total.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Previews</dt>
              <dd>{status.withThumb.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Media</dt>
              <dd>{status.withMedia.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Folders</dt>
              <dd>
                {folderCount.toLocaleString()}
                <span className="muted"> · {folderRevision}</span>
              </dd>
            </div>
            <div>
              <dt>On disk</dt>
              <dd>{diskParts[0] ?? diskLabel}</dd>
            </div>
            <div className="sync-metrics-path">
              <dt>Library path</dt>
              <dd title={status.rootPath}>{status.rootPath}</dd>
            </div>
          </dl>
          {folderPending > 0 ? (
            <p className="muted sync-folder-pending">
              {folderPending.toLocaleString()} pending folder change
              {folderPending === 1 ? "" : "s"}
              {folderSyncResult?.unavailable
                ? " · cloud folders unavailable"
                : ""}
            </p>
          ) : null}

          {folderConflicts.length > 0 ? (
            <div
              className="sync-folder-conflicts"
              aria-label="Folder sync conflicts"
            >
              <p className="sync-folder-conflicts-title">
                Folder conflicts — choose which side to keep, then apply
              </p>
              <ul className="sync-folder-conflicts-list">
                {folderConflicts.map((conflict) => (
                  <li key={conflict.id} className="sync-folder-conflict">
                    <div className="sync-folder-conflict-copy">
                      <strong>{folderConflictKindLabel(conflict.kind)}</strong>
                      <span className="muted">{conflict.summary}</span>
                    </div>
                    <div className="sync-folder-conflict-choices">
                      <label className="sync-folder-choice">
                        <input
                          type="radio"
                          name={`folder-conflict-${conflict.id}`}
                          checked={folderResolutions[conflict.id] === "local"}
                          onChange={() =>
                            onFolderResolution(conflict.id, "local")
                          }
                        />
                        This desktop ({conflict.localLabel})
                      </label>
                      <label className="sync-folder-choice">
                        <input
                          type="radio"
                          name={`folder-conflict-${conflict.id}`}
                          checked={folderResolutions[conflict.id] === "cloud"}
                          onChange={() =>
                            onFolderResolution(conflict.id, "cloud")
                          }
                        />
                        Cloud ({conflict.cloudLabel})
                      </label>
                    </div>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  !allConflictsResolved || foldersLocked || catalogLocked
                }
                onClick={onResolveFolderConflicts}
              >
                {resolvingFolders
                  ? "Applying resolutions…"
                  : "Apply resolutions and retry"}
              </button>
            </div>
          ) : null}

          {status.withoutCloudUrls.length > 0 ? (
            <div
              className="sync-uncacheable"
              aria-label="Creations without cloud URLs"
            >
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

          {(cachingThumbs || cachingMedia || liveDownloads.length > 0) && (
            <section className="sync-live" aria-label="Downloads in progress">
              <div className="sync-live-head">
                <h3 className="sync-section-title">In progress</h3>
                {(cachingThumbs || cachingMedia) && progress ? (
                  <span className="muted">
                    {progress.done}/{progress.total}
                  </span>
                ) : null}
              </div>
              {(cachingThumbs || cachingMedia) && progress && progress.total > 0 ? (
                <div
                  className="sync-progress-track"
                  aria-hidden
                >
                  <div
                    className="sync-progress-fill"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round((100 * progress.done) / progress.total),
                      )}%`,
                    }}
                  />
                </div>
              ) : null}
              {liveDownloads.length > 0 ? (
                <ul className="sync-live-list">
                  {liveDownloads.map((item) => (
                    <li key={item.key}>
                      <span className="sync-live-title" title={item.title}>
                        {item.title}
                      </span>
                      <span className="muted">
                        {syncItemKindLabel(item.kind)}
                      </span>
                      <span className="sync-queue-state state-active">
                        {syncItemStateLabel(item.state, item.kind)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          )}

          {failedDownloads.length > 0 ? (
            <section className="sync-live is-failed" aria-label="Failed downloads">
              <h3 className="sync-section-title">Failed downloads</h3>
              <ul className="sync-live-list">
                {failedDownloads.map((item) => (
                  <li key={item.key}>
                    <span className="sync-live-title" title={item.title}>
                      {item.title}
                    </span>
                    <span
                      className="sync-queue-state state-failed"
                      title={item.detail ?? undefined}
                    >
                      {item.detail || "Failed"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="sync-recent" aria-label="Recent jobs">
            <div className="sync-recent-head">
              <h3 className="sync-section-title">Recent jobs</h3>
              <button
                type="button"
                className="btn ghost"
                onClick={onClearFinished}
                disabled={
                  jobItems.filter((j) => j.state !== "queued" && j.state !== "active")
                    .length === 0
                }
              >
                Clear
              </button>
            </div>
            {jobItems.length === 0 ? (
              <p className="muted sync-recent-empty">
                Catalog and folder runs show up here. Individual preview downloads
                stay in “In progress” only while they run.
              </p>
            ) : (
              <ul className="sync-recent-list">
                {[...jobItems].reverse().map((item) => (
                  <li
                    key={item.key}
                    className={`sync-recent-item is-${item.state}`}
                  >
                    <div className="sync-recent-main">
                      <span className="sync-recent-title">{item.title}</span>
                      {item.detail ? (
                        <span className="muted sync-recent-detail">
                          {item.detail}
                        </span>
                      ) : null}
                    </div>
                    <span
                      className={`sync-queue-state state-${item.state}`}
                    >
                      {syncItemStateLabel(item.state, item.kind)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
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
    catalogSyncMode,
    repairing,
    loadingMore,
    progress,
    activity,
    syncHeadline,
    cachingKind,
    syncingGroups,
    folderSync,
    folderSyncResult,
    folderConflicts,
    folderResolutions,
    setFolderResolutions,
    folderSyncing,
    resolvingFolders,
    runSync,
    runNewestSync,
    runFullSync,
    runGroupMembersSync,
    retryLastCatalogSync,
    runFolderOnlySync,
    runResolveFolderConflicts,
    runCacheThumbs,
    runCacheMedia,
    runCloudRepair,
    runImportFromDisk,
    clearFinishedActivity,
    clearError,
    loadMore,
    refreshStatus,
    refreshFolderSync,
    importing,
  } = useCatalog(librarySurface);

  useEffect(() => {
    if (librarySurface === "sync") return;
    void refreshFolderSync();
  }, [librarySurface, refreshFolderSync]);

  return (
    <div className="library-view">
      {librarySurface === "sync" ? (
        <SyncPanel
          status={status}
          error={error}
          syncing={syncing}
          catalogSyncMode={catalogSyncMode}
          repairing={repairing}
          progress={progress}
          activity={activity}
          syncHeadline={syncHeadline}
          cachingKind={cachingKind}
          syncingGroups={syncingGroups}
          folderSync={folderSync}
          folderSyncResult={folderSyncResult}
          folderConflicts={folderConflicts}
          folderResolutions={folderResolutions}
          onFolderResolution={(conflictId, choice) => {
            setFolderResolutions((prev) => ({
              ...prev,
              [conflictId]: choice,
            }));
          }}
          onResolveFolderConflicts={() => {
            void runResolveFolderConflicts();
          }}
          folderSyncing={folderSyncing}
          resolvingFolders={resolvingFolders}
          onNewestSync={runNewestSync}
          onFullSync={runFullSync}
          onGroupMembersSync={runGroupMembersSync}
          onRetryAfterReauth={retryLastCatalogSync}
          onFolderSync={runFolderOnlySync}
          onCacheThumbs={runCacheThumbs}
          onCacheMedia={runCacheMedia}
          onCloudRepair={runCloudRepair}
          onClearFinished={clearFinishedActivity}
          onClearError={clearError}
          onRefreshStatus={refreshStatus}
          onRefreshFolderSync={refreshFolderSync}
        />
      ) : null}
      <div
        className={
          librarySurface === "creations"
            ? "library-surface"
            : "library-surface is-hidden"
        }
        aria-hidden={librarySurface !== "creations"}
      >
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
          seedFolders={folderSync?.folders ?? []}
          surfaceActive={librarySurface === "creations"}
        />
      </div>
    </div>
  );
}
