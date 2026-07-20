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
import { useAuth } from "../auth/AuthProvider";
import { isSessionReauthError } from "../auth/errors";
import { useShell } from "../app/ShellProvider";
import type { LibrarySurface } from "../app/shellSession";
import { CreationsFilterEmpty } from "./CreationsFilterEmpty";
import { runCloudLibraryRepair } from "../sync/cloudRepair";
import {
  folderConflictKindLabel,
  syncLibraryFolders,
  type FolderConflict,
  type FolderSyncResult,
} from "../sync/folderSync";
import {
  syncCreationsMetadata,
  syncFullCreationsManifest,
  syncNewestCreationsManifest,
  NEWEST_SYNC_MAX_PAGES,
  NEWEST_SYNC_PAGE_SIZE,
} from "../sync/manifestSync";
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
  listGroupMemberIds,
} from "./catalogClient";
import { CreationLightbox } from "./CreationLightbox";
import { FolderCreateModal } from "./FolderCreateModal";
import { FolderEditModal } from "./FolderEditModal";
import { FolderPickModal } from "./FolderPickModal";
import {
  addToFolder,
  createFolder,
  getFolderSyncState,
  listFiledCreationIds,
  listFolders,
  omitFiledCreations,
  removeFromFolder,
  renameFolder,
  type FolderSyncState,
  type LibraryFolder,
} from "./folderClient";
import {
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

function hasLayoutAspect(c: Creation): boolean {
  return Boolean(c.aspectRatio) || (Boolean(c.width) && Boolean(c.height));
}

type CatalogSyncMode = "newest" | "full";

function catalogSyncLabel(
  mode: CatalogSyncMode,
  active: boolean,
  progress: DownloadProgress | null,
): string {
  const idle = mode === "newest" ? "Sync newest" : "Full sync";
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
          ? "Fetch the newest creations (up to ~100) and clear recent remote deletions from local. Use Full sync to rebuild the whole catalog."
          : "Refresh the full creations catalog (edits, removals, recovery)"
      }
    >
      {catalogSyncLabel(mode, active, progress)}
    </button>
  );
}

function useCatalog(librarySurface: LibrarySurface) {
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
  const offsetRef = useRef(0);
  const creationsRef = useRef<Creation[]>([]);
  const aspectBackfillStarted = useRef(false);
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

  // One-shot metadata refresh if the local catalog predates aspect fields.
  // Skip while Sync is focused — board layout isn't visible there.
  useEffect(() => {
    if (librarySurface === "sync") return;
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
  }, [creations, librarySurface, loadInitial]);

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
      const folderResult = await syncLibraryFolders(opts);
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
    [refreshFolderSync],
  );

  const [catalogSyncMode, setCatalogSyncMode] =
    useState<CatalogSyncMode | null>(null);
  const [syncHeadline, setSyncHeadline] = useState<string | null>(null);

  const pushActivity = useCallback((event: SyncItemEvent) => {
    setActivity((prev) => applySyncItemEvent(prev, event));
  }, []);

  const runCatalogSync = useCallback(
    async (mode: CatalogSyncMode) => {
      const jobId = `${mode}-${Date.now()}`;
      const title = mode === "newest" ? "Sync newest" : "Full sync";
      const newestTarget = NEWEST_SYNC_PAGE_SIZE * NEWEST_SYNC_MAX_PAGES;
      lastCatalogModeRef.current = mode;
      lastProgressUiAt.current = 0;
      setSyncing(true);
      setCatalogSyncMode(mode);
      setError(null);
      setFolderSyncResult(null);
      // Paint immediately — don't wait for the first network round-trip.
      setSyncHeadline(
        mode === "newest" ? "Starting Sync newest…" : "Starting Full sync…",
      );
      setProgress({
        done: 0,
        total: mode === "newest" ? newestTarget : 0,
        currentId:
          mode === "newest" ? "Starting Sync newest…" : "Starting Full sync…",
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
        const newest =
          mode === "newest"
            ? await syncNewestCreationsManifest({
                onProgress: (p) => {
                  const now = Date.now();
                  const isTerminal = p.phase === "done";
                  if (!isTerminal && now - lastProgressUiAt.current < 200) {
                    return;
                  }
                  lastProgressUiAt.current = now;
                  setSyncHeadline(p.message);
                  setProgress({
                    done: p.checked,
                    total: p.target,
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
              })
            : null;
        const next = newest
          ? newest.status
          : await syncFullCreationsManifest();
        setStatus(next);

        const added =
          newest?.added ?? Math.max(0, next.total - beforeTotal);
        const pruned = newest?.pruned ?? 0;
        const detail =
          mode === "newest"
            ? [
                added > 0
                  ? `Added ${added.toLocaleString()} creation(s)`
                  : "No new creations",
                pruned > 0
                  ? `removed ${pruned.toLocaleString()} deleted locally`
                  : null,
                "Previews may warm in the background.",
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
  const [deferredKeepIds, setDeferredKeepIds] = useState<Set<string>>(
    () => new Set(),
  );
  const empty = creations !== null && creations.length === 0 && folders.length === 0;

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
  const folderFilterFetchKeyRef = useRef<string>("");

  if (folderView || !needsFolderMemberFilter) {
    if (folderFilterMembersLoading) setFolderFilterMembersLoading(false);
  } else if (folders.length === 0) {
    if (folderFilterMembersById.size > 0) {
      setFolderFilterMembersById(new Map());
    }
    if (folderFilterMembersLoading) setFolderFilterMembersLoading(false);
  }

  useEffect(() => {
    if (folderView || !needsFolderMemberFilter) return;
    if (folders.length === 0) {
      folderFilterFetchKeyRef.current = "";
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
    void Promise.resolve().then(() => {
      if (!cancelled && cache.size === 0) setFolderFilterMembersLoading(true);
    });

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

  const visibleCreations = useMemo(() => {
    if (gridBlank || !creations) return [];
    if (folderView) {
      if (!folderMembers) return [];
      // Inside a folder, show members even if they also belong to a group.
      return filterCreationsVisible(
        folderMembers,
        gridFilters,
        selectedIds,
        deferredKeepIds,
        inProjectIds,
      );
    }
    const unfiled = omitGroupMemberCreations(
      omitFiledCreations(creations, filedIds),
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
    creations,
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
          4,
          groupMemberIds,
        ),
      );
    }
    return map;
  }, [
    folderFilterCreationsById,
    gridFilters,
    groupMemberIds,
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
  catalogSyncMode,
  repairing,
  progress,
  activity,
  syncHeadline,
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

  useEffect(() => {
    onRefreshStatus();
    onRefreshFolderSync();
    // Idle Sync tab: slow poll. Active work: moderate — status is SQLite + cached disk size.
    const ms = syncing || folderSyncing || repairing ? 5_000 : 30_000;
    const id = window.setInterval(() => {
      onRefreshStatus();
      // Folders change rarely — refresh every other tick while idle.
      folderPollTick.current += 1;
      if (syncing || folderSyncing || repairing || folderPollTick.current % 2 === 0) {
        onRefreshFolderSync();
      }
    }, ms);
    return () => window.clearInterval(id);
  }, [
    folderSyncing,
    onRefreshFolderSync,
    onRefreshStatus,
    repairing,
    syncing,
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

  const catalogLocked = syncing || repairing;
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
        ? `Caching previews ${progress!.done}/${progress!.total}`
        : cachingMedia
          ? `Caching media ${progress!.done}/${progress!.total}`
          : liveDownloads.length > 0
            ? `Warming ${liveDownloads.length.toLocaleString()} file(s)…`
            : null);

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
              className={`sync-now${liveHeadline ? " is-live" : ""}`}
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
                Newest pulls ~100 latest creations and clears local copies of
                recent Parascene deletions. Full rebuilds the whole library.
              </p>
              <div className="sync-section-actions">
                <CatalogSyncButton
                  mode="newest"
                  primary
                  active={syncing && catalogSyncMode === "newest"}
                  disabled={catalogLocked}
                  onSync={onNewestSync}
                  progress={progress}
                />
                <CatalogSyncButton
                  mode="full"
                  active={syncing && catalogSyncMode === "full"}
                  disabled={catalogLocked}
                  onSync={onFullSync}
                  progress={progress}
                />
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
                <button
                  type="button"
                  className="btn ghost"
                  onClick={onCacheThumbs}
                  disabled={cacheLocked || missingThumbs === 0}
                >
                  {cachingThumbs
                    ? `Previews ${progress!.done}/${progress!.total}`
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
                  disabled={cacheLocked || missingMedia === 0}
                >
                  {cachingMedia
                    ? `Media ${progress!.done}/${progress!.total}`
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
    runSync,
    runNewestSync,
    runFullSync,
    retryLastCatalogSync,
    runFolderOnlySync,
    runResolveFolderConflicts,
    runCacheThumbs,
    runCacheMedia,
    runCloudRepair,
    runImportFromDisk,
    clearFinishedActivity,
    clearError,
    activity,
    syncHeadline,
    folderSync,
    folderSyncResult,
    folderConflicts,
    folderResolutions,
    setFolderResolutions,
    folderSyncing,
    resolvingFolders,
    loadMore,
    refreshStatus,
    refreshFolderSync,
    importing,
  } = useCatalog(librarySurface);

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
          onRetryAfterReauth={() => {
            void retryLastCatalogSync();
          }}
          onFolderSync={runFolderOnlySync}
          onCacheThumbs={runCacheThumbs}
          onCacheMedia={runCacheMedia}
          onCloudRepair={runCloudRepair}
          onClearFinished={clearFinishedActivity}
          onClearError={clearError}
          onRefreshStatus={refreshStatus}
          onRefreshFolderSync={() => {
            void refreshFolderSync();
          }}
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
