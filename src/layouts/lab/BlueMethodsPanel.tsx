/**
 * Lab panel: Parascene Blue methods from GET /api capabilities.
 * Reuses shared schema form helpers (+ ReplicateLocalOutput) like Replicate Lab.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BLUE_CREDENTIALS_CHANGED_EVENT } from "../../settings/events";
import {
  blueCapabilities,
  blueCapabilitiesToListPage,
  blueCredentialsStatus,
  blueMethodThumbColor,
  blueMethodThumbColors,
  blueMethodToDetail,
  listenBlueRunProgress,
  type BlueCapabilities,
} from "../../blue/blueClient";
import {
  cancelLabGenerateJob,
  runBlueGenerate,
} from "../../services/labGenerate";
import {
  ensureLocal,
  getCreation,
  importLocalPaths,
  listCreations,
} from "../../library/catalogClient";
import {
  creationCardTitle,
  isGroupCreation,
} from "../../library/creationFlags";
import { CreationLightbox } from "../../library/CreationLightbox";
import { creationPreviewUrl } from "../../library/previewUrl";
import type { Creation } from "../../library/types";
import { replicatePickLocalFile } from "../../replicate/replicateClient";
import type {
  ReplicateInputField,
  ReplicateRunProgressEvent,
  ReplicateRunResult,
} from "../../replicate/replicateClient";
import { ReplicateLocalOutput } from "../../replicate/replicateLocalOutput";
import { ReplicateDetailClose } from "../../replicate/ReplicateDetailClose";
import {
  LabLibraryFilePickerDialog,
  type LabRunFilePick,
} from "./LabLibraryFilePicker";
import {
  loadLabFileListPicksForModel,
  loadLabFilePicksForModel,
  loadLabFormValues,
  loadLabSelection,
  saveLabFileListPick,
  saveLabFilePick,
  saveLabFormValues,
  saveLabSelection,
} from "./labRunFormPersist";
import {
  buildRunInput,
  defaultFormValue,
  fileFieldKind,
  fileFieldLabel,
  formatRunError,
  isAnyFileField,
  isFileArrayField,
  isFileField,
  resolveFormValue,
  runnableFields,
} from "./labSchemaForm";
import { SchemaFields } from "../../forms/SchemaFields";
import { REPLICATE_ROW_HEIGHT } from "./ReplicateModelsVirtualList";
import { formatLabDuration } from "./labDuration";

type Props = {
  onOpenSettings?: () => void;
  imageAssets?: Creation[];
  audioAssets?: Creation[];
  videoAssets?: Creation[];
};

const DETAIL_WIDTH_KEY = "parascene.lab.blueMethodsDetailWidth";
const DETAIL_MIN = 240;
const LIST_MIN = 180;
const DETAIL_DEFAULT = 360;

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

function pathBasename(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : path;
}

function pickLabel(
  pick: LabRunFilePick,
  creations: Map<string, Creation>,
): string {
  if (pick.kind === "path") return pathBasename(pick.path);
  const creation = creations.get(pick.creationId);
  return creation
    ? creationCardTitle(creation).text
    : "Saved Library file";
}

async function localPathForCreation(creation: Creation): Promise<string> {
  let path = creation.localPath?.trim() || null;
  if (!path) {
    await ensureLocal([creation.id], { fullMedia: true, urgent: true });
    const fresh = await getCreation(creation.id);
    path = fresh.localPath?.trim() || null;
  }
  if (!path) {
    throw new Error(
      `“${creation.title || creation.id}” is not available locally. Sync it from Library first.`,
    );
  }
  return path;
}

async function resolvePickToPath(
  pick: LabRunFilePick,
  creations: Map<string, Creation>,
): Promise<string> {
  if (pick.kind === "path") return pick.path;
  const creation = creations.get(pick.creationId);
  if (!creation) {
    const fresh = await getCreation(pick.creationId);
    return localPathForCreation(fresh);
  }
  return localPathForCreation(creation);
}

type RunSlot = {
  id: number;
  status: "pending" | "running" | "ready" | "error";
  result?: ReplicateRunResult;
  error?: string;
};

export function BlueMethodsPanel({
  onOpenSettings,
  imageAssets = [],
  audioAssets = [],
  videoAssets = [],
}: Props) {
  const [credsOk, setCredsOk] = useState<boolean | null>(null);
  const [caps, setCaps] = useState<BlueCapabilities | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(() =>
    loadLabSelection("blue"),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runValues, setRunValues] = useState<Record<string, string>>({});
  const [runFilePicks, setRunFilePicks] = useState<
    Record<string, LabRunFilePick>
  >({});
  const [runFileListPicks, setRunFileListPicks] = useState<
    Record<string, LabRunFilePick[]>
  >({});
  const [libraryPicker, setLibraryPicker] = useState<{
    fieldName: string;
    mode: "single" | "append";
  } | null>(null);
  const [libraryImages, setLibraryImages] = useState<Creation[]>([]);
  const [libraryAudio, setLibraryAudio] = useState<Creation[]>([]);
  const [libraryVideo, setLibraryVideo] = useState<Creation[]>([]);
  const [runBusy, setRunBusy] = useState(false);
  const [runProgress, setRunProgress] =
    useState<ReplicateRunProgressEvent | null>(null);
  const [runSlots, setRunSlots] = useState<RunSlot[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [lightboxCreation, setLightboxCreation] = useState<Creation | null>(
    null,
  );
  const [activatingPath, setActivatingPath] = useState<string | null>(null);
  const [detailWidth, setDetailWidth] = useState(loadDetailWidth);
  const [splitDragging, setSplitDragging] = useState(false);
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const splitRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string | null>(null);
  const activeJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const rows = useMemo(
    () => (caps ? blueCapabilitiesToListPage(caps, query).rows : []),
    [caps, query],
  );

  const detail = useMemo(() => {
    if (!selected || !caps?.methods?.[selected]) return null;
    return blueMethodToDetail(
      selected,
      caps.methods[selected],
      caps.capability_matrix,
    );
  }, [caps, selected]);

  const formFields = useMemo(
    () => (detail ? runnableFields(detail.inputs) : []),
    [detail],
  );

  const thumbColors = useMemo(
    () => blueMethodThumbColors(rows.map((r) => r.name)),
    [rows],
  );

  const needsLibraryMedia = useMemo(
    () => formFields.some((f) => isAnyFileField(f)),
    [formFields],
  );

  const pickerImages = useMemo(() => {
    const byId = new Map<string, Creation>();
    for (const c of imageAssets) {
      if (c.mediaType === "image" && !isGroupCreation(c)) byId.set(c.id, c);
    }
    for (const c of libraryImages) {
      if (!byId.has(c.id)) byId.set(c.id, c);
    }
    return [...byId.values()];
  }, [imageAssets, libraryImages]);

  const pickerAudio = useMemo(() => {
    const byId = new Map<string, Creation>();
    for (const c of audioAssets) {
      if (c.mediaType === "audio") byId.set(c.id, c);
    }
    for (const c of libraryAudio) {
      if (!byId.has(c.id)) byId.set(c.id, c);
    }
    return [...byId.values()];
  }, [audioAssets, libraryAudio]);

  const pickerVideo = useMemo(() => {
    const byId = new Map<string, Creation>();
    for (const c of videoAssets) {
      if (c.mediaType === "video" && !isGroupCreation(c)) byId.set(c.id, c);
    }
    for (const c of libraryVideo) {
      if (!byId.has(c.id)) byId.set(c.id, c);
    }
    return [...byId.values()];
  }, [videoAssets, libraryVideo]);

  const allPickerCreations = useMemo(() => {
    const byId = new Map<string, Creation>();
    for (const c of [...pickerImages, ...pickerAudio, ...pickerVideo]) {
      byId.set(c.id, c);
    }
    return byId;
  }, [pickerImages, pickerAudio, pickerVideo]);

  useEffect(() => {
    if (!needsLibraryMedia) return;
    let cancelled = false;
    void listCreations()
      .then((rows) => {
        if (cancelled) return;
        setLibraryImages(
          rows.filter((c) => c.mediaType === "image" && !isGroupCreation(c)),
        );
        setLibraryAudio(rows.filter((c) => c.mediaType === "audio"));
        setLibraryVideo(
          rows.filter((c) => c.mediaType === "video" && !isGroupCreation(c)),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setLibraryImages([]);
          setLibraryAudio([]);
          setLibraryVideo([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [needsLibraryMedia]);

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
    setSelected(null);
    saveLabSelection("blue", null);
    setRunValues({});
    setRunFilePicks({});
    setRunFileListPicks({});
    setRunSlots([]);
    setRunError(null);
  }, []);

  const hydrateRunForm = useCallback(
    (methodId: string, nextCaps: BlueCapabilities) => {
      const def = nextCaps.methods?.[methodId];
      if (!def) return;
      const d = blueMethodToDetail(methodId, def, nextCaps.capability_matrix);
      const fields = runnableFields(d.inputs);
      const saved = loadLabFormValues("blue", methodId);
      const next: Record<string, string> = {};
      for (const f of fields) {
        if (isAnyFileField(f)) continue;
        const prev = saved[f.name];
        next[f.name] =
          prev !== undefined && prev.trim() !== ""
            ? prev
            : defaultFormValue(f);
      }
      setRunValues(next);
      setRunFilePicks(loadLabFilePicksForModel("blue", methodId, fields));
      setRunFileListPicks(
        loadLabFileListPicksForModel("blue", methodId, fields),
      );
      setRunSlots([]);
      setRunError(null);
    },
    [],
  );

  const selectMethod = useCallback(
    (methodId: string) => {
      setSelected(methodId);
      saveLabSelection("blue", methodId);
      if (caps) hydrateRunForm(methodId, caps);
    },
    [caps, hydrateRunForm],
  );

  const setRunFileForField = useCallback(
    (fieldName: string, pick: LabRunFilePick | null) => {
      setRunFilePicks((prev) => {
        const next = { ...prev };
        if (pick) next[fieldName] = pick;
        else delete next[fieldName];
        return next;
      });
      if (selected) saveLabFilePick("blue", selected, fieldName, pick);
    },
    [selected],
  );

  const setRunFileListForField = useCallback(
    (fieldName: string, picks: LabRunFilePick[]) => {
      setRunFileListPicks((prev) => {
        const next = { ...prev };
        if (picks.length) next[fieldName] = picks;
        else delete next[fieldName];
        return next;
      });
      if (selected) {
        saveLabFileListPick("blue", selected, fieldName, picks);
      }
    },
    [selected],
  );

  const appendRunFileListItem = useCallback(
    (fieldName: string, pick: LabRunFilePick) => {
      setRunFileListPicks((prev) => {
        const list = [...(prev[fieldName] ?? []), pick];
        if (selected) {
          saveLabFileListPick("blue", selected, fieldName, list);
        }
        return { ...prev, [fieldName]: list };
      });
    },
    [selected],
  );

  const removeRunFileListItem = useCallback(
    (fieldName: string, index: number) => {
      setRunFileListPicks((prev) => {
        const list = [...(prev[fieldName] ?? [])];
        list.splice(index, 1);
        if (selected) {
          saveLabFileListPick("blue", selected, fieldName, list);
        }
        const next = { ...prev };
        if (list.length) next[fieldName] = list;
        else delete next[fieldName];
        return next;
      });
    },
    [selected],
  );

  const refreshCreds = useCallback(async () => {
    try {
      const st = await blueCredentialsStatus();
      setCredsOk(st.configured);
    } catch {
      setCredsOk(false);
    }
  }, []);

  const loadCaps = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await blueCapabilities();
      setCaps(next);
      const current = selectedRef.current;
      if (current && next.methods && !next.methods[current]) {
        setSelected(null);
        saveLabSelection("blue", null);
      } else if (current && next.methods?.[current]) {
        hydrateRunForm(current, next);
      }
    } catch (err) {
      setCaps(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [hydrateRunForm]);

  useEffect(() => {
    // Bootstrap Blue credentials from Settings / env.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshCreds();
  }, [refreshCreds]);

  useEffect(() => {
    const onChange = () => {
      void refreshCreds();
    };
    window.addEventListener(BLUE_CREDENTIALS_CHANGED_EVENT, onChange);
    return () =>
      window.removeEventListener(BLUE_CREDENTIALS_CHANGED_EVENT, onChange);
  }, [refreshCreds]);

  useEffect(() => {
    if (credsOk !== true) return;
    // Load capabilities after credentials are confirmed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCaps();
  }, [credsOk, loadCaps]);

  useEffect(() => {
    if (!selected || !detail || detail.name !== selected) return;
    const timer = window.setTimeout(() => {
      saveLabFormValues("blue", selected, runValues);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [runValues, selected, detail]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenBlueRunProgress((ev) => setRunProgress(ev)).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const onRun = async () => {
    if (!selected || !detail) return;
    // Backfill blank required selects (browser may show first option while state is "").
    const values: Record<string, string> = { ...runValues };
    let backfilled = false;
    for (const field of formFields) {
      if (isAnyFileField(field)) continue;
      const resolved = resolveFormValue(field, values);
      if ((values[field.name] ?? "") !== resolved) {
        values[field.name] = resolved;
        backfilled = true;
      }
    }
    if (backfilled) setRunValues(values);
    for (const field of formFields) {
      if (!field.required) continue;
      if (isFileField(field) && !runFilePicks[field.name]) {
        setRunError(`Required: ${field.title || field.name}`);
        return;
      }
      if (isFileArrayField(field) && !runFileListPicks[field.name]?.length) {
        setRunError(`Required: ${field.title || field.name}`);
        return;
      }
      if (!isAnyFileField(field) && !(values[field.name] ?? "").trim()) {
        setRunError(`Required: ${field.title || field.name}`);
        return;
      }
    }

    setRunError(null);
    setRunBusy(true);
    setRunProgress(null);
    setRunSlots([{ id: 0, status: "running" }]);
    activeJobIdRef.current = null;

    try {
      const input = buildRunInput(
        formFields.filter((f) => !isAnyFileField(f)),
        values,
      );
      const localFiles: Record<string, string | string[]> = {};
      for (const field of formFields) {
        if (isFileField(field) && runFilePicks[field.name]) {
          localFiles[field.name] = await resolvePickToPath(
            runFilePicks[field.name],
            allPickerCreations,
          );
        } else if (
          isFileArrayField(field) &&
          runFileListPicks[field.name]?.length
        ) {
          localFiles[field.name] = await Promise.all(
            runFileListPicks[field.name].map((pick) =>
              resolvePickToPath(pick, allPickerCreations),
            ),
          );
        }
      }
      const result = await runBlueGenerate({
        method: selected,
        args: input,
        localFiles,
        onJob: (jobId) => {
          activeJobIdRef.current = jobId;
        },
      });
      setRunSlots([{ id: 0, status: "ready", result }]);
    } catch (err) {
      const message = formatRunError(
        err instanceof Error ? err.message : String(err),
      );
      setRunError(message);
      setRunSlots([{ id: 0, status: "error", error: message }]);
    } finally {
      activeJobIdRef.current = null;
      setRunBusy(false);
    }
  };

  const onActivateOutput = async (path: string) => {
    setActivatingPath(path);
    try {
      const imported = await importLocalPaths([path]);
      if (imported.creations[0]) setLightboxCreation(imported.creations[0]);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivatingPath(null);
    }
  };

  const renderField = (field: ReplicateInputField) => {
    const label = field.title || field.name;
    const kind = isAnyFileField(field) ? fileFieldKind(field) : null;

    if (isFileArrayField(field)) {
      const list = runFileListPicks[field.name] ?? [];
      const kindSafe = kind ?? "any";
      return (
        <div key={field.name} className="lab-replicate-run-field">
          <div className="lab-replicate-run-field-head">
            <span>
              <span className="lab-replicate-run-field-name">{field.name}</span>
              <span className="muted">
                {" "}
                {fileFieldLabel(kindSafe)}
                {field.required ? " · required" : ""}
              </span>
            </span>
          </div>
          {label !== field.name ? (
            <div className="muted lab-replicate-run-field-title">{label}</div>
          ) : null}
          <div className="lab-replicate-file-list">
            {list.length === 0 ? (
              <p className="muted">No files yet</p>
            ) : (
              list.map((item, index) => {
                const selectedCreation =
                  item.kind === "creation"
                    ? allPickerCreations.get(item.creationId)
                    : undefined;
                const thumb =
                  selectedCreation &&
                  (selectedCreation.mediaType === "image" ||
                    selectedCreation.mediaType === "video")
                    ? creationPreviewUrl(selectedCreation)
                    : null;
                return (
                  <div
                    key={`${field.name}-${index}`}
                    className="lab-replicate-file-list-item"
                  >
                    <span className="lab-replicate-image-chosen-thumb">
                      {thumb ? (
                        <img src={thumb} alt="" />
                      ) : (
                        <span className="muted">
                          {kindSafe === "audio"
                            ? "♪"
                            : kindSafe === "video"
                              ? "▶"
                              : "…"}
                        </span>
                      )}
                    </span>
                    <span
                      className="lab-replicate-image-chosen-label"
                      title={
                        item.kind === "path"
                          ? item.path
                          : pickLabel(item, allPickerCreations)
                      }
                    >
                      {pickLabel(item, allPickerCreations)}
                      {item.kind === "path" ? (
                        <span className="muted"> · local</span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={runBusy}
                      onClick={() => removeRunFileListItem(field.name, index)}
                    >
                      Remove
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div className="lab-replicate-image-pick-row">
            <button
              type="button"
              className="btn ghost"
              disabled={runBusy}
              onClick={() =>
                setLibraryPicker({ fieldName: field.name, mode: "append" })
              }
            >
              Add from Library
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={runBusy}
              onClick={() => {
                void (async () => {
                  try {
                    const path = await replicatePickLocalFile(kindSafe);
                    if (path) {
                      appendRunFileListItem(field.name, {
                        kind: "path",
                        path,
                      });
                    }
                  } catch (err) {
                    setRunError(
                      formatRunError(
                        err instanceof Error ? err.message : String(err),
                      ),
                    );
                  }
                })();
              }}
            >
              Add local file…
            </button>
            {list.length > 0 ? (
              <button
                type="button"
                className="btn ghost"
                disabled={runBusy}
                onClick={() => setRunFileListForField(field.name, [])}
              >
                Clear all
              </button>
            ) : null}
          </div>
          {field.description ? (
            <p className="muted lab-replicate-run-help">{field.description}</p>
          ) : null}
        </div>
      );
    }

    if (isFileField(field) && kind) {
      const pick = runFilePicks[field.name];
      const selectedCreation =
        pick?.kind === "creation"
          ? allPickerCreations.get(pick.creationId)
          : undefined;
      const thumb =
        selectedCreation &&
        (selectedCreation.mediaType === "image" ||
          selectedCreation.mediaType === "video")
          ? creationPreviewUrl(selectedCreation)
          : null;
      const chosenLabel = pick
        ? pick.kind === "path"
          ? pathBasename(pick.path)
          : selectedCreation
            ? creationCardTitle(selectedCreation).text
            : "Saved Library file"
        : "";
      return (
        <div key={field.name} className="lab-replicate-run-field">
          <div className="lab-replicate-run-field-head">
            <span>
              <span className="lab-replicate-run-field-name">{field.name}</span>
              <span className="muted">
                {" "}
                {fileFieldLabel(kind)}
                {field.required ? " · required" : ""}
              </span>
            </span>
          </div>
          {label !== field.name ? (
            <div className="muted lab-replicate-run-field-title">{label}</div>
          ) : null}
          <div className="lab-replicate-image-pick-row">
            {pick ? (
              <div className="lab-replicate-image-chosen">
                {kind === "image" || kind === "video" || kind === "any" ? (
                  <button
                    type="button"
                    className="lab-replicate-image-chosen-thumb"
                    disabled={runBusy}
                    title="Choose another file"
                    onClick={() =>
                      setLibraryPicker({
                        fieldName: field.name,
                        mode: "single",
                      })
                    }
                  >
                    {thumb ? (
                      <img src={thumb} alt="" />
                    ) : (
                      <span className="muted">
                        {kind === "video" ? "▶" : "…"}
                      </span>
                    )}
                  </button>
                ) : (
                  <span
                    className="lab-replicate-image-chosen-thumb"
                    aria-hidden
                  >
                    <span className="muted">♪</span>
                  </span>
                )}
                <span
                  className="lab-replicate-image-chosen-label"
                  title={pick.kind === "path" ? pick.path : chosenLabel}
                >
                  {chosenLabel}
                  {pick.kind === "path" ? (
                    <span className="muted"> · local</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={runBusy}
                  onClick={() =>
                    setLibraryPicker({
                      fieldName: field.name,
                      mode: "single",
                    })
                  }
                >
                  Choose from Library
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={runBusy}
                  onClick={() => {
                    void (async () => {
                      try {
                        const path = await replicatePickLocalFile(kind);
                        if (path) {
                          setRunFileForField(field.name, {
                            kind: "path",
                            path,
                          });
                        }
                      } catch (err) {
                        setRunError(
                          formatRunError(
                            err instanceof Error ? err.message : String(err),
                          ),
                        );
                      }
                    })();
                  }}
                >
                  Choose local file…
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={runBusy}
                  onClick={() => setRunFileForField(field.name, null)}
                >
                  Clear
                </button>
              </div>
            ) : (
              <div className="lab-replicate-image-chosen">
                <button
                  type="button"
                  className="btn ghost"
                  disabled={runBusy}
                  onClick={() =>
                    setLibraryPicker({
                      fieldName: field.name,
                      mode: "single",
                    })
                  }
                >
                  Choose from Library
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={runBusy}
                  onClick={() => {
                    void (async () => {
                      try {
                        const path = await replicatePickLocalFile(kind);
                        if (path) {
                          setRunFileForField(field.name, {
                            kind: "path",
                            path,
                          });
                        }
                      } catch (err) {
                        setRunError(
                          formatRunError(
                            err instanceof Error ? err.message : String(err),
                          ),
                        );
                      }
                    })();
                  }}
                >
                  Choose local file…
                </button>
              </div>
            )}
          </div>
          {field.description ? (
            <p className="muted lab-replicate-run-help">{field.description}</p>
          ) : null}
        </div>
      );
    }

    return null;
  };

  return (
    <div className="lab-replicate" aria-label="Parascene Blue methods">
      <header className="lab-replicate-titlebar">
        <h2 className="lab-replicate-title">Parascene Blue methods</h2>
        <div className="lab-replicate-toolbar">
          {credsOk === false ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => onOpenSettings?.()}
            >
              Open Settings
            </button>
          ) : null}
          {credsOk === true ? (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => void loadCaps()}
            >
              Refresh capabilities
            </button>
          ) : null}
        </div>
      </header>

      {credsOk === false ? (
        <p className="muted">
          Parascene Blue credentials are not set. Add them in Settings (account
          menu), or set <code>PARASCENE_BLUE_*</code> in the process env.
        </p>
      ) : null}

      {credsOk === true ? (
        <>
          <div className="lab-replicate-search">
            <input
              className="control"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter methods (name, description, capabilities)"
              aria-label="Filter Blue methods"
            />
          </div>
          {error ? (
            <p className="settings-error" role="alert">
              {error}
            </p>
          ) : null}
          <div
            ref={splitRef}
            className={
              selected ? "lab-replicate-split has-detail" : "lab-replicate-split"
            }
          >
            <div className="lab-replicate-list-pane">
              {busy && !rows.length ? (
                <p className="muted lab-replicate-empty">Loading capabilities…</p>
              ) : rows.length === 0 ? (
                <p className="muted lab-replicate-empty">No methods match.</p>
              ) : (
                <div className="lab-replicate-virtual" role="list">
                  {rows.map((r) => {
                    const active = selected === r.name;
                    const meta = r.features.slice(0, 4).join(" · ");
                    const thumbColor =
                      thumbColors.get(r.name) ?? blueMethodThumbColor(r.name);
                    return (
                      <button
                        key={r.name}
                        type="button"
                        role="listitem"
                        className={
                          active
                            ? "lab-replicate-row is-active"
                            : "lab-replicate-row"
                        }
                        style={{ height: REPLICATE_ROW_HEIGHT }}
                        onClick={() => {
                          if (selected) {
                            saveLabFormValues("blue", selected, runValues);
                          }
                          selectMethod(r.name);
                        }}
                      >
                        <span
                          className="lab-replicate-thumb is-empty is-blue-method"
                          style={{ backgroundColor: thumbColor }}
                          aria-hidden
                        />
                        <span className="lab-replicate-row-body">
                          <span className="lab-replicate-row-title">
                            {r.name}
                          </span>
                          {meta ? (
                            <span className="lab-replicate-row-meta">
                              <span className="muted">{meta}</span>
                            </span>
                          ) : null}
                          {r.description ? (
                            <span className="muted lab-replicate-row-desc">
                              {r.description}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
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
                    <div className="lab-replicate-detail-loading is-with-close">
                      <ReplicateDetailClose onClick={closeDetail} />
                      <p className="muted">Loading…</p>
                    </div>
                  ) : (
                    <>
                      <header className="lab-replicate-detail-header is-with-close">
                        <ReplicateDetailClose onClick={closeDetail} />
                        <h3>{detail.name}</h3>
                        {detail.description ? (
                          <p className="muted">{detail.description}</p>
                        ) : null}
                      </header>
                      {detail.features.length ? (
                        <div className="lab-replicate-chips">
                          {detail.features.map((f) => (
                            <span key={f} className="lab-replicate-chip">
                              {f}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <section className="lab-replicate-run">
                        <h4>Run</h4>
                        <form
                          className="lab-replicate-run-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void onRun();
                          }}
                        >
                          <SchemaFields
                            fields={formFields}
                            values={runValues}
                            onChange={(name, value) =>
                              setRunValues((prev) => ({
                                ...prev,
                                [name]: value,
                              }))
                            }
                            disabled={runBusy}
                            showAspectPreview
                            renderFileField={renderField}
                          />
                          <div className="lab-replicate-run-actions">
                            <button
                              type="submit"
                              className="btn primary"
                              disabled={runBusy}
                            >
                              {runBusy ? "Running…" : "Generate"}
                            </button>
                            {runBusy ? (
                              <button
                                type="button"
                                className="btn ghost"
                                onClick={() => {
                                  const id = activeJobIdRef.current;
                                  if (id) void cancelLabGenerateJob(id);
                                }}
                              >
                                Cancel
                              </button>
                            ) : null}
                          </div>
                        </form>
                        {runProgress ? (
                          <p className="muted">
                            {runProgress.status}
                            {runProgress.message
                              ? ` — ${runProgress.message}`
                              : ""}
                          </p>
                        ) : null}
                        {runError ? (
                          <pre className="lab-replicate-run-error">
                            {runError}
                          </pre>
                        ) : null}
                        {runSlots.map((slot) => (
                          <div key={slot.id} className="lab-replicate-run-slot">
                            {slot.status === "ready" && slot.result ? (
                              <>
                                {slot.result.predictTime != null ? (
                                  <p className="muted lab-replicate-run-time">
                                    Time {formatLabDuration(slot.result.predictTime)}
                                  </p>
                                ) : null}
                                {slot.result.localPaths.map((path) => (
                                  <ReplicateLocalOutput
                                    key={path}
                                    path={path}
                                    activating={activatingPath === path}
                                    onActivate={() =>
                                      void onActivateOutput(path)
                                    }
                                  />
                                ))}
                              </>
                            ) : null}
                            {slot.status === "error" ? (
                              <p className="muted">{slot.error}</p>
                            ) : null}
                            {slot.status === "running" ||
                            slot.status === "pending" ? (
                              <p className="muted">{slot.status}…</p>
                            ) : null}
                          </div>
                        ))}
                      </section>
                    </>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </>
      ) : null}

      {libraryPicker ? (
        <LabLibraryFilePickerDialog
          fieldName={libraryPicker.fieldName}
          field={
            formFields.find((f) => f.name === libraryPicker.fieldName) ?? null
          }
          pick={runFilePicks[libraryPicker.fieldName] ?? null}
          pickerImages={pickerImages}
          pickerAudio={pickerAudio}
          pickerVideo={pickerVideo}
          onClose={() => setLibraryPicker(null)}
          onPickCreation={(id) => {
            const pick: LabRunFilePick = { kind: "creation", creationId: id };
            if (libraryPicker.mode === "append") {
              appendRunFileListItem(libraryPicker.fieldName, pick);
            } else {
              setRunFileForField(libraryPicker.fieldName, pick);
            }
            setLibraryPicker(null);
          }}
        />
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
