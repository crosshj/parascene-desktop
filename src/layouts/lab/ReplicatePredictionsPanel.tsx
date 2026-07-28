/**
 * Lab panel: local Replicate prediction history (in-progress + complete).
 * List on the left, detail + settings/outputs on the right when a row is selected.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { importLocalPaths } from "../../library/catalogClient";
import {
  listenReplicateRunProgress,
  replicatePredictionDownload,
  replicatePredictionGet,
  replicatePredictionsList,
  type ReplicatePredictionDetail,
  type ReplicatePredictionListRow,
  type ReplicatePredictionRecord,
} from "../../replicate/replicateClient";
import { ReplicateDetailClose } from "../../replicate/ReplicateDetailClose";
import { outputMediaKind } from "../../replicate/outputMediaKind";
import { ReplicateLocalOutput } from "../../replicate/replicateLocalOutput";

const DETAIL_WIDTH_KEY = "parascene.lab.replicatePredictionsDetailWidth";
const DETAIL_MIN = 280;
const LIST_MIN = 320;
const DETAIL_DEFAULT = 400;

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
    return Math.max(DETAIL_MIN, n);
  } catch {
    return DETAIL_DEFAULT;
  }
}

function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatWhen(isoOrMs?: string | number | null): string {
  if (isoOrMs == null || isoOrMs === "") return "—";
  try {
    const d =
      typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return String(isoOrMs);
    return d.toLocaleString();
  } catch {
    return "—";
  }
}

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "succeeded") return "is-succeeded";
  if (s === "failed" || s === "canceled" || s === "cancelled") return "is-failed";
  if (s === "starting" || s === "processing" || s === "downloading") {
    return "is-running";
  }
  return "is-other";
}

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "starting", label: "Starting" },
  { id: "processing", label: "Processing" },
  { id: "downloading", label: "Downloading" },
  { id: "succeeded", label: "Succeeded" },
  { id: "failed", label: "Failed" },
  { id: "canceled", label: "Canceled" },
] as const;

function mediaPathsForLibrary(paths: string[]): string[] {
  return paths.filter(
    (path) => path && outputMediaKind(path) !== "other",
  );
}

function canSavePredictionToLibrary(
  record: ReplicatePredictionRecord,
): boolean {
  if (mediaPathsForLibrary(record.localPaths).length > 0) return true;
  const status = record.status.toLowerCase();
  return (
    record.outputUrls.length > 0 &&
    (status === "succeeded" || status === "downloading")
  );
}

export function ReplicatePredictionsPanel() {
  const [rows, setRows] = useState<ReplicatePredictionListRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [queryApplied, setQueryApplied] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReplicatePredictionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [detailWidth, setDetailWidth] = useState(loadDetailWidth);
  const [splitDragging, setSplitDragging] = useState(false);
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const splitRef = useRef<HTMLDivElement>(null);

  const commitSearch = useCallback((raw: string) => {
    setQuery(raw);
    setQueryApplied(raw.trim());
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await replicatePredictionsList({
        status: statusFilter === "all" ? null : statusFilter,
        query: queryApplied || null,
      });
      setRows(list);
      setLastUpdated(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [queryApplied, statusFilter]);

  useEffect(() => {
    // Load local prediction history from BE when filters change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenReplicateRunProgress(() => {
      void refresh();
      if (selectedId) {
        void replicatePredictionGet(selectedId)
          .then(setDetail)
          .catch(() => {});
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [refresh, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void replicatePredictionGet(selectedId)
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
  }, [selectedId]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = splitDragRef.current;
      if (!drag) return;
      const next = drag.startWidth - (event.clientX - drag.startX);
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

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
    setSaveMessage(null);
    setSavingToLibrary(false);
  }, []);

  const savePredictionToLibrary = useCallback(
    async (record: ReplicatePredictionRecord) => {
      setSavingToLibrary(true);
      setSaveMessage(null);
      setError(null);
      try {
        let paths = mediaPathsForLibrary(record.localPaths);
        if (paths.length === 0 && record.outputUrls.length > 0) {
          setSaveMessage("Downloading outputs…");
          const downloaded = await replicatePredictionDownload(
            record.predictionId,
          );
          paths = mediaPathsForLibrary(downloaded.localPaths);
          const refreshed = await replicatePredictionGet(record.predictionId);
          if (refreshed) setDetail(refreshed);
        }
        if (paths.length === 0) {
          throw new Error(
            "No media files to import. Outputs may still be downloading, or are not image/video/audio.",
          );
        }
        setSaveMessage("Importing to Library…");
        const imported = await importLocalPaths(paths);
        if (imported.creations.length === 0) {
          throw new Error(
            "Import produced no Library creations. Outputs may not be supported media types.",
          );
        }
        const n = imported.creations.length;
        setSaveMessage(
          n === 1
            ? "Saved to Library as a local-only creation."
            : `Saved ${n} files to Library as local-only creations.`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSaveMessage(null);
      } finally {
        setSavingToLibrary(false);
      }
    },
    [],
  );

  const record = detail?.record;
  const selectedRow = selectedId
    ? rows.find((r) => r.predictionId === selectedId)
    : undefined;
  const showSaveToLibrary = record ? canSavePredictionToLibrary(record) : false;

  return (
    <div className="lab-replicate lab-replicate-predictions" aria-label="Replicate predictions">
      <header className="lab-replicate-titlebar">
        <h2 className="lab-replicate-title">Replicate predictions</h2>
        <div className="lab-replicate-toolbar">
          <span className="muted">
            {lastUpdated ? `Last updated ${formatWhen(lastUpdated)}` : null}
          </span>
          <button
            type="button"
            className="btn ghost"
            disabled={loading}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="lab-replicate-pred-filters">
        <label className="lab-replicate-pred-filter">
          <span className="muted">Status</span>
          <select
            className="control"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <div className="lab-replicate-search">
          <input
            className="control"
            type="search"
            value={query}
            onChange={(e) => {
              const next = e.target.value;
              setQuery(next);
              if (!next.trim() && queryApplied) {
                setQueryApplied("");
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSearch(e.currentTarget.value);
            }}
            placeholder="Model or prediction id"
            aria-label="Filter predictions"
          />
          <button
            type="button"
            className="btn ghost"
            onClick={() => commitSearch(query)}
          >
            Search
          </button>
        </div>
      </div>

      <div className="lab-replicate-split" ref={splitRef}>
        <div className="lab-replicate-list-pane">
          {rows.length === 0 ? (
            <p className="lab-replicate-empty muted">
              {loading
                ? "Loading…"
                : "No local predictions yet. Run a model from Replicate models."}
            </p>
          ) : (
            <div className="lab-replicate-pred-table-wrap">
              <table className="lab-replicate-pred-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>ID</th>
                    <th>Model</th>
                    <th>Running</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const active = row.predictionId === selectedId;
                    return (
                      <tr
                        key={row.predictionId}
                        className={active ? "is-active" : undefined}
                        onClick={() => {
                          setSelectedId(row.predictionId);
                          setSaveMessage(null);
                        }}
                      >
                        <td>
                          <span
                            className={`lab-replicate-pred-status ${statusClass(row.status)}`}
                          >
                            {row.status}
                          </span>
                        </td>
                        <td>
                          <code className="lab-replicate-pred-id">
                            {row.predictionId}
                          </code>
                        </td>
                        <td>
                          <div className="lab-replicate-pred-model">
                            {row.thumbPath ? (
                              <img
                                src={convertFileSrc(row.thumbPath)}
                                alt=""
                                className="lab-replicate-pred-thumb"
                              />
                            ) : (
                              <span className="lab-replicate-pred-thumb is-empty" />
                            )}
                            <span>
                              {row.owner}/{row.name}
                              {row.version ? (
                                <span className="muted">
                                  :{row.version}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        </td>
                        <td>{formatDuration(row.predictTime)}</td>
                        <td>{formatWhen(row.createdAt ?? row.updatedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selectedId ? (
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
              {!record ? (
                <div className="lab-replicate-detail-loading is-with-close">
                  <ReplicateDetailClose onClick={closeDetail} />
                  {selectedRow?.audioPath ? (
                    <section className="lab-replicate-run-outputs">
                      <h4>Output</h4>
                      <ReplicateLocalOutput path={selectedRow.audioPath} />
                    </section>
                  ) : (
                    <p className="muted">Loading…</p>
                  )}
                </div>
              ) : (
                <>
                  <header className="lab-replicate-detail-header is-with-close">
                    <ReplicateDetailClose onClick={closeDetail} />
                    <p className="muted">Prediction</p>
                    <h3>
                      <code>{record.predictionId}</code>
                    </h3>
                    <p>
                      <span
                        className={`lab-replicate-pred-status ${statusClass(record.status)}`}
                      >
                        {record.status}
                      </span>{" "}
                      <span className="muted">
                        · {record.owner}/{record.name}
                      </span>
                    </p>
                    {record.error ? (
                      <p className="lab-replicate-progress is-error">
                        {record.error}
                      </p>
                    ) : null}
                  </header>

                  <section className="lab-replicate-pred-meta">
                    <div>
                      <span className="muted">Created</span>
                      <div>{formatWhen(record.createdAt)}</div>
                    </div>
                    <div>
                      <span className="muted">Started</span>
                      <div>{formatWhen(record.startedAt)}</div>
                    </div>
                    <div>
                      <span className="muted">Completed</span>
                      <div>{formatWhen(record.completedAt)}</div>
                    </div>
                    <div>
                      <span className="muted">Predict time</span>
                      <div>{formatDuration(record.predictTime)}</div>
                    </div>
                    {record.version ? (
                      <div className="lab-replicate-pred-meta-wide">
                        <span className="muted">Version</span>
                        <div>
                          <code>{record.version}</code>
                        </div>
                      </div>
                    ) : null}
                  </section>

                  <section>
                    <h4>Input</h4>
                    <pre className="lab-replicate-pred-json">
                      {JSON.stringify(record.input ?? {}, null, 2)}
                    </pre>
                  </section>

                  {record.localPaths.length > 0 ? (
                    <section className="lab-replicate-run-outputs">
                      <div className="lab-replicate-output-heading">
                        <h4>Output</h4>
                        {showSaveToLibrary ? (
                          <button
                            type="button"
                            className="btn primary"
                            disabled={savingToLibrary}
                            onClick={() => void savePredictionToLibrary(record)}
                          >
                            {savingToLibrary ? "Saving…" : "Save to Library"}
                          </button>
                        ) : null}
                      </div>
                      {record.localPaths.map((path) => (
                        <ReplicateLocalOutput key={path} path={path} />
                      ))}
                      <p className="muted">
                        Saved under <code>{record.runDir}</code>
                      </p>
                      {saveMessage ? (
                        <p className="muted lab-replicate-save-status" role="status">
                          {saveMessage}
                        </p>
                      ) : null}
                    </section>
                  ) : record.outputPreview ? (
                    <section className="lab-replicate-run-outputs">
                      <h4>Output</h4>
                      <pre className="lab-replicate-pred-json">
                        {record.outputPreview}
                      </pre>
                    </section>
                  ) : record.outputUrls.length > 0 ? (
                    <section className="lab-replicate-run-outputs">
                      <div className="lab-replicate-output-heading">
                        <h4>Output URLs</h4>
                        {showSaveToLibrary ? (
                          <button
                            type="button"
                            className="btn primary"
                            disabled={savingToLibrary}
                            onClick={() => void savePredictionToLibrary(record)}
                          >
                            {savingToLibrary ? "Saving…" : "Save to Library"}
                          </button>
                        ) : null}
                      </div>
                      <ul className="lab-replicate-inputs">
                        {record.outputUrls.map((url) => (
                          <li key={url}>
                            <code>{url}</code>
                          </li>
                        ))}
                      </ul>
                      {saveMessage ? (
                        <p className="muted lab-replicate-save-status" role="status">
                          {saveMessage}
                        </p>
                      ) : null}
                    </section>
                  ) : (
                    <p className="muted">No local outputs yet.</p>
                  )}
                </>
              )}
            </div>
          </>
        ) : null}
      </div>

      {error ? (
        <footer className="lab-replicate-statusbar">
          <p className="lab-replicate-progress is-error">{error}</p>
        </footer>
      ) : null}
    </div>
  );
}
