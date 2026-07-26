/**
 * Presentational Lab panel for the Rust-owned Replicate model catalog.
 * FE only invokes commands, listens for progress, and holds selection state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  listenReplicateModelsProgress,
  replicateCacheStats,
  replicateModelGet,
  replicateModelsCheckNew,
  replicateModelSetEnabled,
  replicateModelsCrawlCancel,
  replicateModelsCrawlPause,
  replicateModelsCrawlStart,
  replicateModelsListCached,
  replicateModelUpdate,
  type ReplicateCacheStats,
  type ReplicateModelDetail,
  type ReplicateModelRow,
  type ReplicateProgressEvent,
} from "../../replicate/replicateClient";
import { useConfirm } from "../../ui/ConfirmDialog";
import { ReplicateModelsVirtualList } from "./ReplicateModelsVirtualList";

type Props = {
  onOpenSettings?: () => void;
};

type SortId =
  | "runs_desc"
  | "runs_asc"
  | "owner_asc"
  | "owner_desc"
  | "name_asc"
  | "name_desc"
  | "owner_name_asc";

const SORT_OPTIONS: { id: SortId; label: string }[] = [
  { id: "runs_desc", label: "Runs (high → low)" },
  { id: "runs_asc", label: "Runs (low → high)" },
  { id: "owner_asc", label: "Owner (A → Z)" },
  { id: "owner_desc", label: "Owner (Z → A)" },
  { id: "name_asc", label: "Model name (A → Z)" },
  { id: "name_desc", label: "Model name (Z → A)" },
  { id: "owner_name_asc", label: "owner/name (A → Z)" },
];

const DETAIL_WIDTH_KEY = "parascene.lab.replicateDetailWidth";
const DETAIL_MIN = 240;
/** Floor for the list column so thumbs + wrapped titles stay usable. */
const LIST_MIN = 180;
const DETAIL_DEFAULT = 360;
/** Rows per BE page — keep small so first paint is fast. */
const LIST_PAGE_SIZE = 60;

function clampDetailWidth(width: number, splitWidth?: number): number {
  const maxFromSplit =
    typeof splitWidth === "number" && splitWidth > 0
      ? Math.max(DETAIL_MIN, splitWidth - LIST_MIN)
      : Number.POSITIVE_INFINITY;
  return Math.min(maxFromSplit, Math.max(DETAIL_MIN, width));
}

function loadDetailWidth(): number {
  try {
    const raw = localStorage.getItem(DETAIL_WIDTH_KEY);
    if (!raw) return DETAIL_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DETAIL_DEFAULT;
    // No absolute max — clamp against the live split width while dragging.
    return Math.max(DETAIL_MIN, n);
  } catch {
    return DETAIL_DEFAULT;
  }
}

function formatWhen(ms?: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

export function ReplicateModelsPanel({ onOpenSettings }: Props) {
  const confirm = useConfirm();
  const [stats, setStats] = useState<ReplicateCacheStats | null>(null);
  const [total, setTotal] = useState(0);
  const [rowCacheVersion, setRowCacheVersion] = useState(0);
  const rowCacheRef = useRef<Map<number, ReplicateModelRow>>(new Map());
  const pendingPagesRef = useRef<Set<number>>(new Set());
  const listQueryRef = useRef({ q: "", sort: "runs_desc" as SortId });
  const [query, setQuery] = useState("");
  const [queryApplied, setQueryApplied] = useState("");
  const [sort, setSort] = useState<SortId>("runs_desc");
  const [selected, setSelected] = useState<{
    owner: string;
    name: string;
  } | null>(null);
  const [detail, setDetail] = useState<ReplicateModelDetail | null>(null);
  const [progress, setProgress] = useState<ReplicateProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [detailWidth, setDetailWidth] = useState(loadDetailWidth);
  const [splitDragging, setSplitDragging] = useState(false);
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const splitRef = useRef<HTMLDivElement>(null);
  const totalRef = useRef(0);
  const loadedPagesRef = useRef<Set<number>>(new Set());

  const ensureVisibleRange = useCallback(
    async (start: number, end: number, q: string, sortId: SortId) => {
      listQueryRef.current = { q, sort: sortId };
      const knownTotal = totalRef.current;
      const firstPage = Math.floor(Math.max(0, start) / LIST_PAGE_SIZE);
      const lastIndex = Math.max(start, end - 1, 0);
      const lastPage = Math.floor(lastIndex / LIST_PAGE_SIZE);
      const pages: number[] = [];
      for (let p = firstPage; p <= lastPage; p++) pages.push(p);
      // Warm page 0 so empty catalogs and first paint resolve without scroll.
      if (!pages.includes(0)) pages.unshift(0);

      await Promise.all(
        pages.map(async (pageIndex) => {
          if (loadedPagesRef.current.has(pageIndex)) return;
          if (pendingPagesRef.current.has(pageIndex)) return;
          // Don't fetch pages past a known total (except page 0 while unknown).
          if (knownTotal > 0 && pageIndex * LIST_PAGE_SIZE >= knownTotal) {
            return;
          }
          pendingPagesRef.current.add(pageIndex);
          if (pageIndex === 0) setListLoading(true);
          try {
            const pageStart = pageIndex * LIST_PAGE_SIZE;
            const page = await replicateModelsListCached({
              query: q || undefined,
              sort: sortId,
              offset: pageStart,
              limit: LIST_PAGE_SIZE,
            });
            if (
              listQueryRef.current.q !== q ||
              listQueryRef.current.sort !== sortId
            ) {
              return;
            }
            totalRef.current = page.total;
            setTotal(page.total);
            for (let i = 0; i < page.rows.length; i++) {
              rowCacheRef.current.set(pageStart + i, page.rows[i]);
            }
            for (const key of [...rowCacheRef.current.keys()]) {
              if (key >= page.total) rowCacheRef.current.delete(key);
            }
            loadedPagesRef.current.add(pageIndex);
            setRowCacheVersion((v) => v + 1);
          } catch (err) {
            if (
              listQueryRef.current.q === q &&
              listQueryRef.current.sort === sortId
            ) {
              setError(err instanceof Error ? err.message : String(err));
            }
          } finally {
            pendingPagesRef.current.delete(pageIndex);
            if (pageIndex === 0) setListLoading(false);
          }
        }),
      );
    },
    [],
  );

  const invalidateList = useCallback(() => {
    rowCacheRef.current = new Map();
    pendingPagesRef.current = new Set();
    loadedPagesRef.current = new Set();
    totalRef.current = 0;
    setTotal(0);
    setRowCacheVersion((v) => v + 1);
    void ensureVisibleRange(0, LIST_PAGE_SIZE, queryApplied, sort);
  }, [ensureVisibleRange, queryApplied, sort]);

  const getRow = useCallback(
    (index: number) => {
      void rowCacheVersion;
      return rowCacheRef.current.get(index);
    },
    [rowCacheVersion],
  );

  const onVisibleRange = useCallback(
    (start: number, end: number) => {
      void ensureVisibleRange(start, end, queryApplied, sort);
    },
    [ensureVisibleRange, queryApplied, sort],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = splitDragRef.current;
      if (!drag) return;
      // Detail is on the right: drag left → wider detail.
      const next =
        drag.startWidth - (event.clientX - drag.startX);
      const split = splitRef.current;
      setDetailWidth(clampDetailWidth(next, split?.clientWidth));
    };
    const onUp = () => {
      if (!splitDragRef.current) return;
      splitDragRef.current = null;
      setSplitDragging(false);
      setDetailWidth((w) => {
        try {
          localStorage.setItem(DETAIL_WIDTH_KEY, String(w));
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
    const split = splitRef.current;
    if (!split) return;
    const reclamp = () => {
      setDetailWidth((w) => clampDetailWidth(w, split.clientWidth));
    };
    reclamp();
    const ro = new ResizeObserver(reclamp);
    ro.observe(split);
    return () => ro.disconnect();
  }, []);
  const refreshStats = useCallback(async () => {
    const s = await replicateCacheStats();
    setStats(s);
    return s;
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      await refreshStats();
      invalidateList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [invalidateList, refreshStats]);

  useEffect(() => {
    // Load local catalog + stats from BE whenever query/sort changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenReplicateModelsProgress((ev) => {
      setProgress(ev);
      if (ev.done) {
        setBusy(false);
        void refreshStats();
        invalidateList();
        if (selected) {
          void replicateModelGet(selected.owner, selected.name)
            .then(setDetail)
            .catch(() => {});
        }
      } else {
        setBusy(true);
        // Live catalog growth while crawling.
        if (ev.phase === "crawl" && ev.merged > 0 && ev.page % 5 === 0) {
          invalidateList();
          void refreshStats();
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [invalidateList, refreshStats, selected]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void replicateModelGet(selected.owner, selected.name)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const applySearch = () => {
    setQueryApplied(query.trim());
  };

  const onCrawl = async (resume: boolean) => {
    setError(null);
    setBusy(true);
    try {
      setStats(await replicateModelsCrawlStart(resume));
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRebuildCatalog = async () => {
    const ok = await confirm({
      title: "Rebuild Replicate catalog?",
      message:
        "This starts a full crawl from scratch and replaces the current local catalog index. Progress from any paused crawl will be discarded. This can take a long time and will call Replicate’s list API.",
      confirmLabel: "Rebuild catalog",
      danger: true,
    });
    if (!ok) return;
    await onCrawl(false);
  };

  const onPause = async () => {
    try {
      setStats(await replicateModelsCrawlPause());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onCancel = async () => {
    try {
      setStats(await replicateModelsCrawlCancel());
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onCheckNew = async () => {
    setError(null);
    setBusy(true);
    try {
      setStats(await replicateModelsCheckNew());
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onUpdateModel = async () => {
    if (!selected) return;
    setError(null);
    setBusy(true);
    try {
      const d = await replicateModelUpdate(selected.owner, selected.name);
      setDetail(d);
      invalidateList();
      await refreshStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onToggleEnabled = async () => {
    if (!selected || !detail) return;
    setError(null);
    setBusy(true);
    try {
      const d = await replicateModelSetEnabled(
        selected.owner,
        selected.name,
        !detail.enabled,
      );
      setDetail(d);
      for (const [index, row] of rowCacheRef.current) {
        if (row.owner === d.owner && row.name === d.name) {
          rowCacheRef.current.set(index, { ...row, enabled: d.enabled });
        }
      }
      setRowCacheVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const statsReady = stats !== null;
  const tokenOk = stats?.tokenConfigured === true;
  const crawlRunning =
    stats?.crawlRunning === true || stats?.checkpoint.status === "running";
  const resumable =
    Boolean(stats?.checkpoint.resumable) &&
    Boolean(stats?.checkpoint.nextUrl) &&
    !crawlRunning;
  const hasCatalog = (stats?.modelCount ?? 0) > 0;
  const selectedKey = selected
    ? `${selected.owner}/${selected.name}`
    : null;

  return (
    <div className="lab-replicate" aria-label="Replicate models">
      <header className="lab-replicate-titlebar">
        <h2 className="lab-replicate-title">Replicate models</h2>
        {statsReady ? (
          <div className="lab-replicate-toolbar">
            {!tokenOk ? (
              <button
                type="button"
                className="btn ghost"
                onClick={() => onOpenSettings?.()}
              >
                Open Settings
              </button>
            ) : null}

            {tokenOk && crawlRunning ? (
              <>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void onPause()}
                >
                  Pause
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void onCancel()}
                >
                  Cancel crawl
                </button>
              </>
            ) : null}

            {tokenOk && resumable ? (
              <>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void onCrawl(true)}
                >
                  Resume crawl
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void onCancel()}
                >
                  Cancel crawl
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void onRebuildCatalog()}
                >
                  Rebuild from scratch
                </button>
              </>
            ) : null}

            {tokenOk && !crawlRunning && !resumable ? (
              <>
                {hasCatalog ? (
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={() => void onRebuildCatalog()}
                  >
                    Rebuild catalog
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy}
                    onClick={() => void onCrawl(false)}
                  >
                    Build catalog
                  </button>
                )}
                {hasCatalog ? (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy}
                    onClick={() => void onCheckNew()}
                  >
                    Check for new models
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="lab-replicate-search">
        <input
          className="control"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") applySearch();
          }}
          placeholder="Filter local catalog (owner, name, description)"
          aria-label="Filter catalog"
        />
        <button type="button" className="btn ghost" onClick={applySearch}>
          Search
        </button>
        <label className="lab-replicate-sort">
          <span className="muted">Sort</span>
          <select
            className="control"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortId)}
            aria-label="Sort catalog"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        ref={splitRef}
        className={
          selected
            ? "lab-replicate-split has-detail"
            : "lab-replicate-split"
        }
      >
        <div className="lab-replicate-list-pane">
          {statsReady && stats.modelCount === 0 && !queryApplied ? (
            <p className="muted">
              Catalog empty — run Build catalog when ready.
            </p>
          ) : (
            <ReplicateModelsVirtualList
              totalCount={total}
              getRow={getRow}
              selectedKey={selectedKey}
              resetKey={`${queryApplied}|${sort}`}
              onVisibleRange={onVisibleRange}
              onSelect={(r) => {
                setDetail(null);
                setSelected({ owner: r.owner, name: r.name });
              }}
            />
          )}
        </div>

        {selected ? (
          <>
            <button
              type="button"
              className={
                splitDragging
                  ? "lab-replicate-split-resizer is-dragging"
                  : "lab-replicate-split-resizer"
              }
              aria-label="Resize detail pane"
              onPointerDown={(event) => {
                event.preventDefault();
                splitDragRef.current = {
                  startX: event.clientX,
                  startWidth: detailWidth,
                };
                setSplitDragging(true);
              }}
            />
            <div
              className="lab-replicate-detail"
              style={{ width: detailWidth, flex: `0 0 ${detailWidth}px` }}
            >
              {!detail ? (
                <p className="muted">Loading…</p>
              ) : (
                <>
                  <header className="lab-replicate-detail-header">
                    {detail.coverImageUrl ? (
                      <img
                        className="lab-replicate-detail-cover"
                        src={detail.coverImageUrl}
                        alt=""
                        referrerPolicy="no-referrer"
                      />
                    ) : null}
                    <h3>
                      {detail.owner}/{detail.name}
                    </h3>
                    <p className="muted">
                      {detail.enabled ? "Enabled for run" : "Not enabled"} ·{" "}
                      {detail.schemaCached
                        ? "Schema cached"
                        : "No schema yet"}{" "}
                      · runs {detail.runCount.toLocaleString()}
                    </p>
                    <div className="lab-replicate-detail-actions">
                      <button
                        type="button"
                        className={detail.enabled ? "btn ghost" : "btn primary"}
                        disabled={busy}
                        onClick={() => void onToggleEnabled()}
                      >
                        {detail.enabled ? "Disable model" : "Enable model"}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={busy || !stats?.tokenConfigured}
                        onClick={() => void onUpdateModel()}
                      >
                        Update model
                      </button>
                      {detail.enabled ? (
                        <span className="muted">
                          Runner not implemented yet.
                        </span>
                      ) : (
                        <span className="muted">
                          Enable to mark this model for future runs.
                        </span>
                      )}
                    </div>
                  </header>
                  {detail.description ? <p>{detail.description}</p> : null}
                  {detail.latestVersionId ? (
                    <p className="muted">
                      Latest version:{" "}
                      <code>{detail.latestVersionId.slice(0, 12)}…</code>
                    </p>
                  ) : null}
                  {detail.features.length > 0 ? (
                    <div className="lab-replicate-chips">
                      {detail.features.map((f) => (
                        <span key={f} className="lab-replicate-chip">
                          {f}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {detail.inputs.length > 0 ? (
                    <section>
                      <h4>Inputs</h4>
                      <ul className="lab-replicate-inputs">
                        {detail.inputs.map((f) => (
                          <li key={f.name}>
                            <strong>{f.title || f.name}</strong>
                            <span className="muted">
                              {" "}
                              · {f.typeName}
                              {f.required ? " · required" : ""}
                            </span>
                            {f.description ? (
                              <div className="muted">{f.description}</div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : (
                    <p className="muted">
                      No input schema cached — use Update model to fetch
                      OpenAPI.
                    </p>
                  )}
                </>
              )}
            </div>
          </>
        ) : null}
      </div>

      <footer className="lab-replicate-statusbar" role="status">
        <div className="lab-replicate-status muted">
          <span>
            Models: <strong>{stats?.modelCount ?? "—"}</strong>
            {queryApplied && total !== (stats?.modelCount ?? -1) ? (
              <> · matching {total.toLocaleString()}</>
            ) : null}
            {listLoading ? " · loading…" : null}
          </span>
          <span>Full crawl: {formatWhen(stats?.meta.lastFullSyncAt)}</span>
          <span>Last check: {formatWhen(stats?.meta.lastIncrementalAt)}</span>
          <span>
            Checkpoint: {stats?.checkpoint.phase || "idle"}
            {stats?.checkpoint.pagesDone
              ? ` · page ${stats.checkpoint.pagesDone}`
              : ""}
            {stats?.checkpoint.modelsMerged
              ? ` · ${stats.checkpoint.modelsMerged} merged`
              : ""}
          </span>
        </div>
        {error ? (
          <p className="lab-replicate-progress is-error">{error}</p>
        ) : progress ? (
          <p
            className={
              progress.error
                ? "lab-replicate-progress is-error"
                : "lab-replicate-progress"
            }
          >
            {progress.message || progress.status}
            {progress.error ? ` — ${progress.error}` : ""}
          </p>
        ) : null}
      </footer>
    </div>
  );
}
