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
  useRef,
  useState,
} from "react";
import { useShell } from "../app/ShellProvider";
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
  cacheMissingMedia,
  cacheMissingThumbs,
  ensureLocal,
  getCreation,
  getSyncStatus,
  listCreationsPage,
} from "./catalogClient";
import { CreationLightbox } from "./CreationLightbox";
import { VirtualCreationsGrid } from "./VirtualCreationsGrid";
import {
  CREATIONS_LOAD_MORE_PAGES,
  CREATIONS_PAGE_SIZE,
  type Creation,
  type DownloadProgress,
  type SyncStatus,
} from "./types";

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
    void listen<Creation>("library-creation-updated", (event) => {
      const next = event.payload;
      const merged = creationsRef.current.map((c) =>
        c.id === next.id ? next : c,
      );
      creationsRef.current = merged;
      setCreations(merged);
      refreshStatus();
    }).then((off) => {
      unlistenRow = off;
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

  return {
    creations,
    total,
    hasMore,
    status,
    error,
    syncing,
    repairing,
    loadingMore,
    progress,
    activity,
    runSync,
    runCacheThumbs,
    runCacheMedia,
    runCloudRepair,
    clearFinishedActivity,
    loadMore,
    refreshStatus,
  };
}

function creationsChromeStatus(opts: {
  creations: Creation[] | null;
  total: number;
  syncing: boolean;
  loadingMore: boolean;
  progress: DownloadProgress | null;
}): string | null {
  const { creations, total, syncing, loadingMore, progress } = opts;
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
}: {
  creations: Creation[] | null;
  total: number;
  error: string | null;
  syncing: boolean;
  loadingMore: boolean;
  progress: DownloadProgress | null;
  onSync: () => void;
  onLoadMore: () => void;
}) {
  const { setChromeStatus } = useShell();
  const [active, setActive] = useState<Creation | null>(null);
  const empty = creations !== null && creations.length === 0;

  useEffect(() => {
    setChromeStatus(
      creationsChromeStatus({
        creations,
        total,
        syncing,
        loadingMore,
        progress,
      }),
    );
    return () => setChromeStatus(null);
  }, [creations, loadingMore, progress, setChromeStatus, syncing, total]);

  return (
    <section className="stub-panel creations-panel" aria-label="Creations">
      {error ? <p className="library-error">{error}</p> : null}
      {creations === null ? (
        <p className="muted">Loading catalog…</p>
      ) : empty ? (
        <div className="library-empty-body">
          <p className="muted">No local creations yet.</p>
          <SyncFromCloudButton
            active={syncing}
            onSync={onSync}
            progress={progress}
          />
        </div>
      ) : (
        <>
          <VirtualCreationsGrid
            creations={creations}
            onOpen={(creation) => {
              setActive(creation);
              // Fire urgent fetch on click — don't wait for lightbox mount.
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
            onNearEnd={onLoadMore}
          />
          {active ? (
            <CreationLightbox
              creation={
                creations.find((c) => c.id === active.id) ?? active
              }
              onClose={() => setActive(null)}
              onDeleted={() => setActive(null)}
            />
          ) : null}
        </>
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
    clearFinishedActivity,
    activity,
    loadMore,
    refreshStatus,
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
        />
      )}
    </div>
  );
}
