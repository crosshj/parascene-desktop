/**
 * Lab panel: combined local Replicate + Parascene Blue prediction history.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  blueCredentialsStatus,
  blueJobDelete,
  blueJobDownload,
  blueJobGet,
  blueJobsList,
  listenBlueRunProgress,
} from "../../blue/blueClient";
import { importLocalPaths } from "../../library/catalogClient";
import { CreationLightbox } from "../../library/CreationLightbox";
import type { Creation } from "../../library/types";
import { outputMediaKind } from "../../replicate/outputMediaKind";
import { ReplicateDetailClose } from "../../replicate/ReplicateDetailClose";
import {
  listenReplicateRunProgress,
  replicatePredictionDelete,
  replicatePredictionDownload,
  replicatePredictionGet,
  replicatePredictionsList,
  replicateTokenStatus,
  type ReplicatePredictionDetail,
  type ReplicatePredictionListRow,
  type ReplicatePredictionRecord,
} from "../../replicate/replicateClient";
import { ReplicateLocalOutput } from "../../replicate/replicateLocalOutput";
import {
  BLUE_CREDENTIALS_CHANGED_EVENT,
  REPLICATE_TOKEN_CHANGED_EVENT,
} from "../../settings/events";
import { useConfirm } from "../../ui/ConfirmDialog";
import { formatLabDuration } from "./labDuration";

const DETAIL_WIDTH_KEY = "parascene.lab.predictionsDetailWidth";
const DETAIL_MIN = 280;
const LIST_MIN = 320;
const DETAIL_DEFAULT = 400;

export type LabPredictionProvider = "replicate" | "blue";

type LabPredictionRow = ReplicatePredictionListRow & {
  provider: LabPredictionProvider;
};

function rowKey(provider: LabPredictionProvider, id: string): string {
  return `${provider}:${id}`;
}

function parseRowKey(
  key: string,
): { provider: LabPredictionProvider; id: string } | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const provider = key.slice(0, i);
  const id = key.slice(i + 1);
  if ((provider !== "replicate" && provider !== "blue") || !id) return null;
  return { provider, id };
}

function providerLabel(provider: LabPredictionProvider): string {
  return provider === "blue" ? "Blue" : "Replicate";
}

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

function formatWhen(isoOrMs?: string | number | null): string {
  if (isoOrMs == null || isoOrMs === "") return "—";
  try {
    const d =
      typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return String(isoOrMs);
    return d.toLocaleString();
  } catch {
    return String(isoOrMs);
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

const PROVIDER_FILTERS = [
  { id: "all", label: "All" },
  { id: "replicate", label: "Replicate" },
  { id: "blue", label: "Blue" },
] as const;

function mediaPathsForLibrary(paths: string[]): string[] {
  return paths.filter((path) => path && outputMediaKind(path) !== "other");
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

async function fetchDetail(
  provider: LabPredictionProvider,
  predictionId: string,
): Promise<ReplicatePredictionDetail | null> {
  return provider === "blue"
    ? blueJobGet(predictionId)
    : replicatePredictionGet(predictionId);
}

async function deleteByProvider(
  provider: LabPredictionProvider,
  predictionId: string,
): Promise<void> {
  if (provider === "blue") await blueJobDelete(predictionId);
  else await replicatePredictionDelete(predictionId);
}

async function downloadByProvider(
  provider: LabPredictionProvider,
  predictionId: string,
) {
  return provider === "blue"
    ? blueJobDownload(predictionId)
    : replicatePredictionDownload(predictionId);
}

function sortPredictionRows(a: LabPredictionRow, b: LabPredictionRow): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

export function PredictionsPanel({
  onOpenSettings,
}: {
  onOpenSettings?: () => void;
}) {
  const confirm = useConfirm();
  const [replicateOk, setReplicateOk] = useState<boolean | null>(null);
  const [blueOk, setBlueOk] = useState<boolean | null>(null);
  const [rows, setRows] = useState<LabPredictionRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [queryApplied, setQueryApplied] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(() => new Set());
  const [detail, setDetail] = useState<ReplicatePredictionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [lightboxCreation, setLightboxCreation] = useState<Creation | null>(
    null,
  );
  const [activatingPath, setActivatingPath] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [detailWidth, setDetailWidth] = useState(loadDetailWidth);
  const [splitDragging, setSplitDragging] = useState(false);
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const splitRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selectedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    selectedKeyRef.current = selectedKey;
  }, [selectedKey]);

  useEffect(() => {
    const refreshCreds = async () => {
      try {
        const [rep, blue] = await Promise.all([
          replicateTokenStatus(),
          blueCredentialsStatus(),
        ]);
        setReplicateOk(rep.configured);
        setBlueOk(blue.configured);
      } catch {
        setReplicateOk(false);
        setBlueOk(false);
      }
    };
    void refreshCreds();
    const onChange = () => {
      void refreshCreds();
    };
    window.addEventListener(REPLICATE_TOKEN_CHANGED_EVENT, onChange);
    window.addEventListener(BLUE_CREDENTIALS_CHANGED_EVENT, onChange);
    return () => {
      window.removeEventListener(REPLICATE_TOKEN_CHANGED_EVENT, onChange);
      window.removeEventListener(BLUE_CREDENTIALS_CHANGED_EVENT, onChange);
    };
  }, []);

  const commitSearch = useCallback((raw: string) => {
    setQuery(raw);
    setQueryApplied(raw.trim());
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const status = statusFilter === "all" ? null : statusFilter;
    const query = queryApplied || null;
    const wantReplicate =
      providerFilter === "all" || providerFilter === "replicate";
    const wantBlue = providerFilter === "all" || providerFilter === "blue";
    try {
      const tasks: Promise<{
        provider: LabPredictionProvider;
        list?: ReplicatePredictionListRow[];
        error?: string;
      }>[] = [];
      if (wantReplicate) {
        tasks.push(
          replicatePredictionsList({ status, query })
            .then((list) => ({ provider: "replicate" as const, list }))
            .catch((err) => ({
              provider: "replicate" as const,
              error: err instanceof Error ? err.message : String(err),
            })),
        );
      }
      if (wantBlue) {
        tasks.push(
          blueJobsList({ status, query })
            .then((list) => ({ provider: "blue" as const, list }))
            .catch((err) => ({
              provider: "blue" as const,
              error: err instanceof Error ? err.message : String(err),
            })),
        );
      }

      const results = await Promise.all(tasks);
      const errors: string[] = [];
      const merged: LabPredictionRow[] = [];
      for (const result of results) {
        if (result.error) {
          errors.push(`${providerLabel(result.provider)}: ${result.error}`);
          continue;
        }
        for (const row of result.list ?? []) {
          merged.push({ ...row, provider: result.provider });
        }
      }
      merged.sort(sortPredictionRows);
      setRows(merged);
      setCheckedKeys((prev) => {
        if (prev.size === 0) return prev;
        const visible = new Set(
          merged.map((r) => rowKey(r.provider, r.predictionId)),
        );
        let changed = false;
        const next = new Set<string>();
        for (const key of prev) {
          if (visible.has(key)) next.add(key);
          else changed = true;
        }
        return changed ? next : prev;
      });
      setLastUpdated(Date.now());
      if (errors.length > 0) setError(errors.join("\n"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [providerFilter, queryApplied, statusFilter]);

  useEffect(() => {
    // Local history is always readable; remote wait/redownload needs creds.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let unlistenRep: (() => void) | undefined;
    let unlistenBlue: (() => void) | undefined;
    let refreshTimer: number | undefined;

    const scheduleRefresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refresh();
        const key = selectedKeyRef.current;
        const parsed = key ? parseRowKey(key) : null;
        if (parsed) {
          void fetchDetail(parsed.provider, parsed.id)
            .then(setDetail)
            .catch(() => {});
        }
      }, 400);
    };

    void listenReplicateRunProgress(scheduleRefresh).then((fn) => {
      unlistenRep = fn;
    });
    void listenBlueRunProgress(scheduleRefresh).then((fn) => {
      unlistenBlue = fn;
    });
    return () => {
      window.clearTimeout(refreshTimer);
      unlistenRep?.();
      unlistenBlue?.();
    };
  }, [refresh]);

  useEffect(() => {
    if (!selectedKey) return;
    const parsed = parseRowKey(selectedKey);
    if (!parsed) return;
    let cancelled = false;
    void fetchDetail(parsed.provider, parsed.id)
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
  }, [selectedKey]);

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
    setSelectedKey(null);
    setDetail(null);
    setSaveMessage(null);
    setSavingToLibrary(false);
  }, []);

  const toggleChecked = useCallback((key: string, on: boolean) => {
    setCheckedKeys((prev) => {
      const has = prev.has(key);
      if (on === has) return prev;
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const setAllVisibleChecked = useCallback(
    (on: boolean) => {
      setCheckedKeys((prev) => {
        const next = new Set(prev);
        for (const row of rows) {
          const key = rowKey(row.provider, row.predictionId);
          if (on) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    },
    [rows],
  );

  const checkedCount = checkedKeys.size;
  const allVisibleChecked =
    rows.length > 0 &&
    rows.every((r) => checkedKeys.has(rowKey(r.provider, r.predictionId)));
  const someVisibleChecked = rows.some((r) =>
    checkedKeys.has(rowKey(r.provider, r.predictionId)),
  );

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    el.indeterminate = someVisibleChecked && !allVisibleChecked;
  }, [allVisibleChecked, someVisibleChecked]);

  const deletePrediction = useCallback(
    async (key: string) => {
      const parsed = parseRowKey(key.trim());
      if (!parsed) {
        setError("Missing prediction id");
        return;
      }
      const ok = await confirm({
        title: "Delete prediction?",
        message:
          "Removes this Lab history entry and its cached local outputs. Library imports (if any) are not deleted.",
        confirmLabel: "Delete",
        danger: true,
        errorTitle: "Could not delete prediction",
        onConfirm: async () => {
          await deleteByProvider(parsed.provider, parsed.id);
        },
      });
      if (!ok) return;
      setCheckedKeys((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      closeDetail();
      await refresh();
    },
    [closeDetail, confirm, refresh],
  );

  const deleteChecked = useCallback(async () => {
    const keys = [...checkedKeys];
    if (keys.length === 0) return;
    const n = keys.length;
    const ok = await confirm({
      title: n === 1 ? "Delete prediction?" : `Delete ${n} predictions?`,
      message:
        n === 1
          ? "Removes this Lab history entry and its cached local outputs. Library imports (if any) are not deleted."
          : `Removes ${n} Lab history entries and their cached local outputs. Library imports (if any) are not deleted.`,
      confirmLabel: n === 1 ? "Delete" : `Delete ${n}`,
      danger: true,
      errorTitle: "Could not delete predictions",
      onConfirm: async ({ setMessage }) => {
        const failures: string[] = [];
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]!;
          const parsed = parseRowKey(key);
          setMessage(`Deleting ${i + 1} of ${n}…`);
          if (!parsed) {
            failures.push(`${key}: invalid id`);
            continue;
          }
          try {
            await deleteByProvider(parsed.provider, parsed.id);
          } catch (err) {
            failures.push(
              `${providerLabel(parsed.provider)} ${parsed.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        if (failures.length > 0) {
          throw new Error(
            `Deleted ${n - failures.length} of ${n}. Failed:\n${failures.join("\n")}`,
          );
        }
      },
    });
    if (!ok) return;
    setCheckedKeys(new Set());
    if (selectedKey && keys.includes(selectedKey)) closeDetail();
    await refresh();
  }, [checkedKeys, closeDetail, confirm, refresh, selectedKey]);

  const savePredictionToLibrary = useCallback(
    async (
      provider: LabPredictionProvider,
      record: ReplicatePredictionRecord,
    ) => {
      setSavingToLibrary(true);
      setSaveMessage(null);
      setError(null);
      try {
        let paths = mediaPathsForLibrary(record.localPaths);
        if (paths.length === 0 && record.outputUrls.length > 0) {
          setSaveMessage("Downloading outputs…");
          const downloaded = await downloadByProvider(
            provider,
            record.predictionId,
          );
          paths = mediaPathsForLibrary(downloaded.localPaths);
          const refreshed = await fetchDetail(provider, record.predictionId);
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

  const openOutputLightbox = useCallback(async (path: string) => {
    setActivatingPath(path);
    setError(null);
    try {
      const imported = await importLocalPaths([path]);
      const creation = imported.creations[0];
      if (!creation) {
        throw new Error(
          "Import produced no Library creation. Output may not be a supported media type.",
        );
      }
      setLightboxCreation(creation);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivatingPath(null);
    }
  }, []);

  const record = detail?.record;
  const selectedParsed = selectedKey ? parseRowKey(selectedKey) : null;
  const selectedRow = selectedKey
    ? rows.find((r) => rowKey(r.provider, r.predictionId) === selectedKey)
    : undefined;
  const selectedProvider =
    selectedRow?.provider ?? selectedParsed?.provider ?? null;
  const showSaveToLibrary = record ? canSavePredictionToLibrary(record) : false;
  const missingCreds =
    replicateOk === false || blueOk === false
      ? [
          replicateOk === false ? "Replicate token" : null,
          blueOk === false ? "Parascene Blue credentials" : null,
        ].filter(Boolean)
      : [];

  return (
    <div
      className="lab-replicate lab-replicate-predictions"
      aria-label="Predictions"
    >
      <header className="lab-replicate-titlebar">
        <h2 className="lab-replicate-title">Predictions</h2>
        <div className="lab-replicate-toolbar">
          {missingCreds.length > 0 ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => onOpenSettings?.()}
            >
              Open Settings
            </button>
          ) : null}
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

      {missingCreds.length > 0 ? (
        <p className="muted">
          {missingCreds.join(" and ")} not set. Wait / redownload need
          credentials — add them in Settings. Local history still lists past
          runs below.
        </p>
      ) : null}

      <div className="lab-replicate-pred-filters">
        <label className="lab-replicate-pred-filter">
          <span className="muted">Source</span>
          <select
            className="control"
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
          >
            {PROVIDER_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
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
        {checkedCount > 0 ? (
          <div className="lab-replicate-pred-bulk">
            <span className="muted">{checkedCount} selected</span>
            <button
              type="button"
              className="btn ghost"
              onClick={() => void deleteChecked()}
            >
              Delete selected
            </button>
          </div>
        ) : null}
      </div>

      <div className="lab-replicate-split" ref={splitRef}>
        <div className="lab-replicate-list-pane">
          {rows.length === 0 ? (
            <p className="lab-replicate-empty muted">
              {loading
                ? "Loading…"
                : "No local predictions yet. Run a model from Replicate models or Parascene Blue methods."}
            </p>
          ) : (
            <div className="lab-replicate-pred-table-wrap">
              <table className="lab-replicate-pred-table">
                <thead>
                  <tr>
                    <th className="lab-replicate-pred-check">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        className="control"
                        checked={allVisibleChecked}
                        onChange={(e) => setAllVisibleChecked(e.target.checked)}
                        aria-label="Select all predictions"
                      />
                    </th>
                    <th>Source</th>
                    <th>Status</th>
                    <th>ID</th>
                    <th>Model</th>
                    <th>Time</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const key = rowKey(row.provider, row.predictionId);
                    const active = key === selectedKey;
                    const checked = checkedKeys.has(key);
                    return (
                      <tr
                        key={key}
                        className={
                          [
                            active ? "is-active" : "",
                            checked ? "is-checked" : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined
                        }
                        onClick={() => {
                          setSelectedKey(key);
                          setDetail(null);
                          setSaveMessage(null);
                        }}
                      >
                        <td
                          className="lab-replicate-pred-check"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            className="control"
                            checked={checked}
                            onChange={(e) =>
                              toggleChecked(key, e.target.checked)
                            }
                            aria-label={`Select ${providerLabel(row.provider)} ${row.predictionId}`}
                          />
                        </td>
                        <td>
                          <span className="lab-replicate-pred-source">
                            {providerLabel(row.provider)}
                          </span>
                        </td>
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
                                <span className="muted">:{row.version}</span>
                              ) : null}
                            </span>
                          </div>
                        </td>
                        <td>
                          {formatLabDuration(
                            row.predictTime ?? row.totalTime,
                          )}
                        </td>
                        <td>{formatWhen(row.createdAt ?? row.updatedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selectedKey ? (
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
                  {selectedRow?.thumbPath ? (
                    <section className="lab-replicate-run-outputs">
                      <h4>Output</h4>
                      <ReplicateLocalOutput
                        path={selectedRow.thumbPath}
                        showPath={false}
                        onActivate={() => {
                          const path = selectedRow.thumbPath;
                          if (path) void openOutputLightbox(path);
                        }}
                        activating={activatingPath === selectedRow.thumbPath}
                      />
                      <p className="muted">Loading details…</p>
                    </section>
                  ) : selectedRow?.audioPath ? (
                    <section className="lab-replicate-run-outputs">
                      <h4>Output</h4>
                      <ReplicateLocalOutput
                        path={selectedRow.audioPath}
                        showPath={false}
                        onActivate={() => {
                          const path = selectedRow.audioPath;
                          if (path) void openOutputLightbox(path);
                        }}
                        activating={activatingPath === selectedRow.audioPath}
                      />
                      <p className="muted">Loading details…</p>
                    </section>
                  ) : (
                    <p className="muted">Loading…</p>
                  )}
                </div>
              ) : (
                <>
                  <header className="lab-replicate-detail-header is-with-close">
                    <ReplicateDetailClose onClick={closeDetail} />
                    <p className="muted">
                      {selectedProvider
                        ? `${providerLabel(selectedProvider)} prediction`
                        : "Prediction"}
                    </p>
                    <h3>
                      <code>
                        {record.predictionId ||
                          parseRowKey(selectedKey)?.id ||
                          selectedKey}
                      </code>
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
                    <div className="lab-replicate-detail-actions">
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => void deletePrediction(selectedKey)}
                      >
                        Delete
                      </button>
                    </div>
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
                      <span className="muted">Time</span>
                      <div>
                        {formatLabDuration(
                          record.predictTime ?? record.totalTime,
                        )}
                      </div>
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
                        {showSaveToLibrary && selectedProvider ? (
                          <button
                            type="button"
                            className="btn primary"
                            disabled={savingToLibrary}
                            onClick={() =>
                              void savePredictionToLibrary(
                                selectedProvider,
                                record,
                              )
                            }
                          >
                            {savingToLibrary ? "Saving…" : "Save to Library"}
                          </button>
                        ) : null}
                      </div>
                      {record.localPaths.map((path) => (
                        <ReplicateLocalOutput
                          key={path}
                          path={path}
                          onActivate={
                            outputMediaKind(path) !== "other"
                              ? () => void openOutputLightbox(path)
                              : undefined
                          }
                          activating={activatingPath === path}
                        />
                      ))}
                      <p className="muted">
                        Saved under <code>{record.runDir}</code>
                      </p>
                      {saveMessage ? (
                        <p
                          className="muted lab-replicate-save-status"
                          role="status"
                        >
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
                        {showSaveToLibrary && selectedProvider ? (
                          <button
                            type="button"
                            className="btn primary"
                            disabled={savingToLibrary}
                            onClick={() =>
                              void savePredictionToLibrary(
                                selectedProvider,
                                record,
                              )
                            }
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
                        <p
                          className="muted lab-replicate-save-status"
                          role="status"
                        >
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

      {lightboxCreation ? (
        <CreationLightbox
          creation={lightboxCreation}
          onClose={() => setLightboxCreation(null)}
        />
      ) : null}
    </div>
  );
}
