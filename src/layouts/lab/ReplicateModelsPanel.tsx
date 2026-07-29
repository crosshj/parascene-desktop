/**
 * Presentational Lab panel for the Rust-owned Replicate model catalog.
 * FE only invokes commands, listens for progress, and holds selection state.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LabImagePicker } from "../../lab/LabImagePicker";
import {
  creationCardTitle,
  isGroupCreation,
} from "../../library/creationFlags";
import {
  ensureLocal,
  getCreation,
  importLocalPaths,
  listCreations,
} from "../../library/catalogClient";
import { CreationLightbox } from "../../library/CreationLightbox";
import { creationPreviewUrl } from "../../library/previewUrl";
import type { Creation } from "../../library/types";
import {
  listenReplicateModelsProgress,
  listenReplicateRunProgress,
  replicateCacheStats,
  replicateModelGet,
  replicateModelRun,
  replicateModelRunCancel,
  replicateModelsCheckNew,
  replicateModelSetEnabled,
  replicateModelsCrawlCancel,
  replicateModelsCrawlPause,
  replicateModelsCrawlStart,
  replicateModelsListCached,
  replicateModelUpdate,
  replicatePickLocalFile,
  type ReplicateCacheStats,
  type ReplicateInputField,
  type ReplicateModelDetail,
  type ReplicateModelRow,
  type ReplicateProgressEvent,
  type ReplicateRunProgressEvent,
  type ReplicateRunResult,
} from "../../replicate/replicateClient";
import { ReplicateLocalOutput } from "../../replicate/replicateLocalOutput";
import { ReplicateDetailClose } from "../../replicate/ReplicateDetailClose";
import {
  aspectChooserOptionsFromSupported,
  pickAspectChooserValue,
  projectAspectCss,
  isProjectAspectRatio,
} from "../../project/aspectRatios";
import { parseAspectRatioString } from "../../library/aspectRatio";
import { AspectRatioChooser } from "../../ui/AspectRatioChooser";
import { copyTextToClipboard } from "../../ui/clipboard";
import { useConfirm } from "../../ui/ConfirmDialog";
import { ReplicateModelsVirtualList } from "./ReplicateModelsVirtualList";

type Props = {
  onOpenSettings?: () => void;
  /** Project images — preferred when present; Library catalog is also loaded. */
  imageAssets?: Creation[];
  audioAssets?: Creation[];
  videoAssets?: Creation[];
};

/** Local file for a URI input: Library creation or absolute disk path. */
type RunFilePick =
  | { kind: "creation"; creationId: string }
  | { kind: "path"; path: string };

type FileFieldKind = "image" | "audio" | "video" | "any";

type SortId =
  | "runs_desc"
  | "runs_asc"
  | "owner_asc"
  | "owner_desc"
  | "name_asc"
  | "name_desc"
  | "owner_name_asc";

type EnabledFilterId = "all" | "enabled" | "disabled";

const BATCH_MAX = 20;
const BATCH_STAGGER_MS = 600;
const BATCH_MAX_IN_FLIGHT = 3;

type RunSlotStatus = "pending" | "running" | "ready" | "error";

type RunSlot = {
  id: number;
  status: RunSlotStatus;
  result?: ReplicateRunResult;
  error?: string;
};
const SORT_OPTIONS: { id: SortId; label: string }[] = [
  { id: "runs_desc", label: "Runs (high → low)" },
  { id: "runs_asc", label: "Runs (low → high)" },
  { id: "owner_asc", label: "Owner (A → Z)" },
  { id: "owner_desc", label: "Owner (Z → A)" },
  { id: "name_asc", label: "Model name (A → Z)" },
  { id: "name_desc", label: "Model name (Z → A)" },
  { id: "owner_name_asc", label: "owner/name (A → Z)" },
];

const ENABLED_FILTER_OPTIONS: { id: EnabledFilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "enabled", label: "Enabled" },
  { id: "disabled", label: "Disabled" },
];

const DETAIL_WIDTH_KEY = "parascene.lab.replicateDetailWidth";
const DETAIL_MIN = 240;
/** Floor for the list column so thumbs + wrapped titles stay usable. */
const LIST_MIN = 180;
const DETAIL_DEFAULT = 360;
/** Rows per BE page — keep small so first paint is fast. */
const LIST_PAGE_SIZE = 60;
/**
 * Persisted file picks: `{ "owner/name::field": "creation:<id>" | "path:<abs>" }`.
 * Legacy bare creation ids are still accepted.
 */
const RUN_FILES_KEY = "parascene.lab.replicateRunImages";

function runFileStorageKey(
  owner: string,
  name: string,
  field: string,
): string {
  return `${owner}/${name}::${field}`;
}

function serializeRunFilePick(pick: RunFilePick): string {
  if (pick.kind === "creation") return `creation:${pick.creationId}`;
  return `path:${pick.path}`;
}

function parseRunFilePick(raw: string): RunFilePick | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith("creation:")) {
    const creationId = t.slice("creation:".length).trim();
    return creationId ? { kind: "creation", creationId } : null;
  }
  if (t.startsWith("path:")) {
    const path = t.slice("path:".length);
    return path ? { kind: "path", path } : null;
  }
  // Legacy: bare creation id
  return { kind: "creation", creationId: t };
}

function loadRunFileMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(RUN_FILES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function saveRunFilePick(
  owner: string,
  name: string,
  field: string,
  pick: RunFilePick | null,
): void {
  try {
    const map = loadRunFileMap();
    const key = runFileStorageKey(owner, name, field);
    if (pick) map[key] = serializeRunFilePick(pick);
    else delete map[key];
    localStorage.setItem(RUN_FILES_KEY, JSON.stringify(map));
  } catch {
    // ignore quota / private mode
  }
}

function loadRunFilePicksForModel(
  owner: string,
  name: string,
  fields: ReplicateInputField[],
): Record<string, RunFilePick> {
  const map = loadRunFileMap();
  const out: Record<string, RunFilePick> = {};
  for (const field of fields) {
    if (!isFileField(field)) continue;
    const raw = map[runFileStorageKey(owner, name, field.name)];
    if (!raw || raw.startsWith("[")) continue;
    const pick = parseRunFilePick(raw);
    if (pick) out[field.name] = pick;
  }
  return out;
}

function loadRunFileListPicksForModel(
  owner: string,
  name: string,
  fields: ReplicateInputField[],
): Record<string, RunFilePick[]> {
  const map = loadRunFileMap();
  const out: Record<string, RunFilePick[]> = {};
  for (const field of fields) {
    if (!isFileArrayField(field)) continue;
    const raw = map[runFileStorageKey(owner, name, field.name)];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) continue;
      const picks: RunFilePick[] = [];
      for (const item of parsed) {
        if (typeof item !== "string") continue;
        const pick = parseRunFilePick(item);
        if (pick) picks.push(pick);
      }
      if (picks.length) out[field.name] = picks;
    } catch {
      // ignore corrupt storage
    }
  }
  return out;
}

function saveRunFileListPick(
  owner: string,
  name: string,
  field: string,
  picks: RunFilePick[],
): void {
  try {
    const map = loadRunFileMap();
    const key = runFileStorageKey(owner, name, field);
    if (picks.length) {
      map[key] = JSON.stringify(picks.map(serializeRunFilePick));
    } else {
      delete map[key];
    }
    localStorage.setItem(RUN_FILES_KEY, JSON.stringify(map));
  } catch {
    // ignore quota / private mode
  }
}

function pickLabel(
  pick: RunFilePick,
  creations: Map<string, Creation>,
): string {
  if (pick.kind === "path") return pathBasename(pick.path);
  const creation = creations.get(pick.creationId);
  return creation
    ? creationCardTitle(creation).text
    : "Saved Library file";
}

function fieldBlob(field: ReplicateInputField): string {
  return `${field.name} ${field.title ?? ""} ${field.description ?? ""}`.toLowerCase();
}

function fileFieldKind(field: ReplicateInputField): FileFieldKind {
  const blob = fieldBlob(field);
  if (blob.includes("audio")) return "audio";
  if (blob.includes("video")) return "video";
  if (
    blob.includes("image") ||
    blob.includes("mask") ||
    blob.includes("photo") ||
    blob.includes("picture")
  ) {
    return "image";
  }
  return "any";
}

function fileFieldLabel(kind: FileFieldKind): string {
  switch (kind) {
    case "image":
      return "uri / image";
    case "audio":
      return "uri / audio";
    case "video":
      return "uri / video";
    default:
      return "uri / file";
  }
}

function pathBasename(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : path;
}

function formatRunError(message: string): string {
  const jsonStart = message.indexOf("{");
  if (jsonStart === -1) return message;
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as unknown;
    const prefix = message.slice(0, jsonStart).trim();
    const body = JSON.stringify(parsed, null, 2);
    return prefix ? `${prefix}\n${body}` : body;
  } catch {
    return message;
  }
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

/** All schema fields including file-like URI inputs (image / audio / video). */
function runnableFields(inputs: ReplicateInputField[]): ReplicateInputField[] {
  return inputs;
}

function isFileField(field: ReplicateInputField): boolean {
  if (field.fileLike) return true;
  // Stale catalog / schemas that omit format:uri but still want a media URL.
  if (field.typeName !== "string") return false;
  if (field.enumValues?.length) return false;
  return looksLikeMediaUrlField(field);
}

function looksLikeMediaUrlField(field: ReplicateInputField): boolean {
  const n = field.name.toLowerCase();
  const blob = fieldBlob(field);
  const urlish =
    n.endsWith("_url") ||
    n.endsWith("_uri") ||
    n.endsWith("_file") ||
    n === "url" ||
    n === "uri" ||
    n === "audio" ||
    n === "video" ||
    n === "image" ||
    blob.includes("publicly accessible") ||
    blob.includes("http") ||
    (field.title ?? "").toLowerCase().includes("url");
  const media =
    blob.includes("audio") ||
    blob.includes("video") ||
    blob.includes("image") ||
    blob.includes("song") ||
    blob.includes("music") ||
    blob.includes("mp3") ||
    blob.includes("wav") ||
    blob.includes("mask") ||
    blob.includes("photo") ||
    blob.includes("picture");
  return urlish && media;
}

function isFileArrayField(field: ReplicateInputField): boolean {
  if (field.arrayItemFileLike) return true;
  // Stale catalog detail may lack arrayItemFileLike until Update model.
  if (field.typeName !== "array") return false;
  const blob = fieldBlob(field);
  return (
    blob.includes("image") ||
    blob.includes("audio") ||
    blob.includes("video") ||
    blob.includes("file")
  );
}

function isAnyFileField(field: ReplicateInputField): boolean {
  return isFileField(field) || isFileArrayField(field);
}

async function resolvePickToPath(
  pick: RunFilePick,
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

function isAspectRatioField(field: ReplicateInputField): boolean {
  const n = field.name.toLowerCase().replace(/-/g, "_");
  return n === "aspect_ratio" || n === "aspectratio";
}

/** CSS `aspect-ratio` from the model's current aspect_ratio form value. */
function aspectCssFromRunValue(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  if (isProjectAspectRatio(value)) return projectAspectCss(value);
  const parts = parseAspectRatioString(value);
  if (!parts) return null;
  return `${parts.w} / ${parts.h}`;
}

function aspectChooserOptionsForField(field: ReplicateInputField) {
  if (!isAspectRatioField(field)) return [];
  return aspectChooserOptionsFromSupported(field.enumValues);
}

function defaultFormValue(field: ReplicateInputField): string {
  const aspectOpts = aspectChooserOptionsForField(field);
  if (aspectOpts.length > 0) {
    const preferred =
      field.defaultValue === null || field.defaultValue === undefined
        ? ""
        : String(field.defaultValue);
    return pickAspectChooserValue(aspectOpts, preferred);
  }
  const d = field.defaultValue;
  if (d === null || d === undefined) {
    if (field.typeName === "boolean") return "false";
    return "";
  }
  if (typeof d === "boolean") return d ? "true" : "false";
  return String(d);
}

function formatDefaultLabel(field: ReplicateInputField): string | null {
  if (field.defaultValue === null || field.defaultValue === undefined) return null;
  if (typeof field.defaultValue === "boolean") {
    return field.defaultValue ? "true" : "false";
  }
  return String(field.defaultValue);
}

/** Slider when OpenAPI provides a finite, usable min/max (skip huge ranges like seed). */
function hasSliderRange(field: ReplicateInputField): boolean {
  const min = field.minimum;
  const max = field.maximum;
  if (min == null || max == null || !(max > min)) return false;
  const span = max - min;
  if (field.typeName === "integer") return span <= 10_000;
  return span <= 10_000;
}

function sliderStep(field: ReplicateInputField): number {
  if (field.typeName === "integer") return 1;
  const min = field.minimum ?? 0;
  const max = field.maximum ?? 1;
  const span = Math.max(0.0001, max - min);
  if (span <= 1) return 0.01;
  if (span <= 20) return 0.1;
  return 1;
}

function clampNumericString(
  raw: string,
  field: ReplicateInputField,
): string {
  if (!raw.trim()) return raw;
  const n =
    field.typeName === "integer"
      ? Number.parseInt(raw, 10)
      : Number(raw);
  if (!Number.isFinite(n)) return raw;
  let v = n;
  if (field.minimum != null) v = Math.max(field.minimum, v);
  if (field.maximum != null) v = Math.min(field.maximum, v);
  if (field.typeName === "integer") return String(Math.round(v));
  return String(v);
}

function isIntegerEnumField(field: ReplicateInputField): boolean {
  const enums = field.enumValues;
  if (!enums?.length) return false;
  return enums.every((v) => /^-?\d+$/.test(v.trim()));
}

function isNumberEnumField(field: ReplicateInputField): boolean {
  const enums = field.enumValues;
  if (!enums?.length) return false;
  return enums.every((v) => Number.isFinite(Number(v)));
}

function buildRunInput(
  fields: ReplicateInputField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const aspectOpts = aspectChooserOptionsForField(field);
    const raw =
      aspectOpts.length > 0
        ? pickAspectChooserValue(aspectOpts, values[field.name])
        : (values[field.name] ?? "");
    const trimmed = raw.trim();
    if (!trimmed && !field.required) continue;
    const typeName =
      field.typeName === "integer" || isIntegerEnumField(field)
        ? "integer"
        : field.typeName === "number" || isNumberEnumField(field)
          ? "number"
          : field.typeName;
    switch (typeName) {
      case "integer": {
        const n = Number.parseInt(trimmed, 10);
        if (Number.isFinite(n)) out[field.name] = n;
        break;
      }
      case "number": {
        const n = Number(trimmed);
        if (Number.isFinite(n)) out[field.name] = n;
        break;
      }
      case "boolean":
        out[field.name] = trimmed === "true" || trimmed === "1";
        break;
      default:
        if (trimmed) out[field.name] = trimmed;
        break;
    }
  }
  return out;
}

function replicateModelPageUrl(detail: {
  owner: string;
  name: string;
  url?: string | null;
}): string {
  const fromApi = detail.url?.trim();
  if (fromApi && /^https?:\/\//i.test(fromApi)) return fromApi;
  return `https://replicate.com/${detail.owner}/${detail.name}`;
}

export function ReplicateModelsPanel({
  onOpenSettings,
  imageAssets = [],
  audioAssets = [],
  videoAssets = [],
}: Props) {
  const confirm = useConfirm();
  const [stats, setStats] = useState<ReplicateCacheStats | null>(null);
  const [total, setTotal] = useState(0);
  const [rowCacheVersion, setRowCacheVersion] = useState(0);
  const rowCacheRef = useRef<Map<number, ReplicateModelRow>>(new Map());
  const pendingPagesRef = useRef<Set<number>>(new Set());
  const listQueryRef = useRef({
    q: "",
    sort: "runs_desc" as SortId,
    enabled: "all" as EnabledFilterId,
  });
  const [query, setQuery] = useState("");
  const [queryApplied, setQueryApplied] = useState("");
  const [sort, setSort] = useState<SortId>("runs_desc");
  const [enabledFilter, setEnabledFilter] =
    useState<EnabledFilterId>("all");
  const [selected, setSelected] = useState<{
    owner: string;
    name: string;
  } | null>(null);
  const [detail, setDetail] = useState<ReplicateModelDetail | null>(null);
  const [progress, setProgress] = useState<ReplicateProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyNamesBusy, setCopyNamesBusy] = useState(false);
  const [copyNamesNote, setCopyNamesNote] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listTiming, setListTiming] = useState<{
    total: number;
    indexLoad: number;
    sort: number;
    cacheHit: boolean;
  } | null>(null);
  const statsRef = useRef<ReplicateCacheStats | null>(null);
  const listGenRef = useRef(0);
  const [detailWidth, setDetailWidth] = useState(loadDetailWidth);
  const [splitDragging, setSplitDragging] = useState(false);
  const [runValues, setRunValues] = useState<Record<string, string>>({});
  /** Library creation or disk path for scalar URI/file fields. */
  const [runFilePicks, setRunFilePicks] = useState<
    Record<string, RunFilePick>
  >({});
  /** Ordered picks for array-of-uri fields (e.g. image_input). */
  const [runFileListPicks, setRunFileListPicks] = useState<
    Record<string, RunFilePick[]>
  >({});
  /** Library picker target: scalar replace or array append. */
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
  const [batchCount, setBatchCount] = useState(1);
  const [runError, setRunError] = useState<string | null>(null);
  const [lightboxCreation, setLightboxCreation] = useState<Creation | null>(
    null,
  );
  const [activatingPath, setActivatingPath] = useState<string | null>(null);
  const batchDoneRef = useRef(0);
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const splitRef = useRef<HTMLDivElement>(null);
  const totalRef = useRef(0);
  const loadedPagesRef = useRef<Set<number>>(new Set());

  const formFields = useMemo(
    () => (detail ? runnableFields(detail.inputs) : []),
    [detail],
  );

  const batchSlotAspectCss = useMemo(() => {
    const field = formFields.find((f) => isAspectRatioField(f));
    if (!field) return null;
    const options = aspectChooserOptionsForField(field);
    const raw =
      options.length > 0
        ? pickAspectChooserValue(options, runValues[field.name])
        : (runValues[field.name] ?? defaultFormValue(field));
    return aspectCssFromRunValue(raw);
  }, [formFields, runValues]);

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
          rows.filter(
            (c) => c.mediaType === "image" && !isGroupCreation(c),
          ),
        );
        setLibraryAudio(rows.filter((c) => c.mediaType === "audio"));
        setLibraryVideo(
          rows.filter(
            (c) => c.mediaType === "video" && !isGroupCreation(c),
          ),
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

  const ensureVisibleRange = useCallback(
    async (
      start: number,
      end: number,
      q: string,
      sortId: SortId,
      enabledId: EnabledFilterId,
      gen: number,
    ) => {
      listQueryRef.current = { q, sort: sortId, enabled: enabledId };
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
          if (gen !== listGenRef.current) return;
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
              enabled: enabledId,
              offset: pageStart,
              limit: LIST_PAGE_SIZE,
            });
            if (
              gen !== listGenRef.current ||
              listQueryRef.current.q !== q ||
              listQueryRef.current.sort !== sortId ||
              listQueryRef.current.enabled !== enabledId
            ) {
              return;
            }
            if (page.timingMs && pageIndex === 0) {
              setListTiming(page.timingMs);
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
              gen === listGenRef.current &&
              listQueryRef.current.q === q &&
              listQueryRef.current.sort === sortId &&
              listQueryRef.current.enabled === enabledId
            ) {
              setError(err instanceof Error ? err.message : String(err));
            }
          } finally {
            pendingPagesRef.current.delete(pageIndex);
            if (pageIndex === 0 && gen === listGenRef.current) {
              setListLoading(false);
            }
          }
        }),
      );
    },
    [],
  );

  const invalidateList = useCallback(() => {
    listGenRef.current += 1;
    const gen = listGenRef.current;
    rowCacheRef.current = new Map();
    pendingPagesRef.current = new Set();
    loadedPagesRef.current = new Set();
    // Keep a provisional total from stats so we show skeletons instead of "no match".
    const provisional =
      !queryApplied &&
      enabledFilter === "all" &&
      (statsRef.current?.modelCount ?? 0) > 0
        ? statsRef.current!.modelCount
        : 0;
    totalRef.current = provisional;
    setTotal(provisional);
    setListLoading(true);
    setListTiming(null);
    setRowCacheVersion((v) => v + 1);
    void ensureVisibleRange(
      0,
      LIST_PAGE_SIZE,
      queryApplied,
      sort,
      enabledFilter,
      gen,
    );
  }, [ensureVisibleRange, queryApplied, sort, enabledFilter]);

  const getRow = useCallback(
    (index: number) => {
      void rowCacheVersion;
      return rowCacheRef.current.get(index);
    },
    [rowCacheVersion],
  );

  const onVisibleRange = useCallback(
    (start: number, end: number) => {
      void ensureVisibleRange(
        start,
        end,
        queryApplied,
        sort,
        enabledFilter,
        listGenRef.current,
      );
    },
    [ensureVisibleRange, queryApplied, sort, enabledFilter],
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
    statsRef.current = s;
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

  const applyDetail = useCallback((d: ReplicateModelDetail | null) => {
    setDetail(d);
    if (!d) {
      setRunValues({});
      setRunFilePicks({});
      setRunFileListPicks({});
      return;
    }
    const fields = runnableFields(d.inputs);
    const next: Record<string, string> = {};
    for (const field of fields) {
      if (isAnyFileField(field)) continue;
      next[field.name] = defaultFormValue(field);
    }
    setRunValues(next);
    setRunFilePicks(loadRunFilePicksForModel(d.owner, d.name, fields));
    setRunFileListPicks(loadRunFileListPicksForModel(d.owner, d.name, fields));
  }, []);

  const setRunFileForField = useCallback(
    (fieldName: string, pick: RunFilePick | null) => {
      setRunFilePicks((prev) => {
        const next = { ...prev };
        if (pick) next[fieldName] = pick;
        else delete next[fieldName];
        return next;
      });
      if (detail) {
        saveRunFilePick(detail.owner, detail.name, fieldName, pick);
      }
    },
    [detail],
  );

  const setRunFileListForField = useCallback(
    (fieldName: string, picks: RunFilePick[]) => {
      setRunFileListPicks((prev) => {
        const next = { ...prev };
        if (picks.length) next[fieldName] = picks;
        else delete next[fieldName];
        return next;
      });
      if (detail) {
        saveRunFileListPick(detail.owner, detail.name, fieldName, picks);
      }
    },
    [detail],
  );

  const appendRunFileListItem = useCallback(
    (fieldName: string, pick: RunFilePick) => {
      setRunFileListPicks((prev) => {
        const list = [...(prev[fieldName] ?? []), pick];
        if (detail) {
          saveRunFileListPick(detail.owner, detail.name, fieldName, list);
        }
        return { ...prev, [fieldName]: list };
      });
    },
    [detail],
  );

  const removeRunFileListItem = useCallback(
    (fieldName: string, index: number) => {
      setRunFileListPicks((prev) => {
        const list = [...(prev[fieldName] ?? [])];
        list.splice(index, 1);
        if (detail) {
          saveRunFileListPick(detail.owner, detail.name, fieldName, list);
        }
        const next = { ...prev };
        if (list.length) next[fieldName] = list;
        else delete next[fieldName];
        return next;
      });
    },
    [detail],
  );

  const selectModel = useCallback((owner: string, name: string) => {
    setRunSlots([]);
    setRunError(null);
    setRunProgress(null);
    setDetail(null);
    setRunValues({});
    setRunFilePicks({});
    setRunFileListPicks({});
    setSelected({ owner, name });
  }, []);

  const closeDetail = useCallback(() => {
    setSelected(null);
    setDetail(null);
    setRunSlots([]);
    setRunError(null);
    setRunProgress(null);
  }, []);

  const openOutputLightbox = useCallback(async (path: string) => {
    setActivatingPath(path);
    setRunError(null);
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
      setRunError(
        formatRunError(err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setActivatingPath(null);
    }
  }, []);

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
            .then(applyDetail)
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
  }, [applyDetail, invalidateList, refreshStats, selected]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenReplicateRunProgress((ev) => {
      setRunProgress(ev);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void replicateModelGet(selected.owner, selected.name)
      .then((d) => {
        if (!cancelled) applyDetail(d);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyDetail, selected]);

  const commitSearch = useCallback((raw: string) => {
    setCopyNamesNote(null);
    setQuery(raw);
    setQueryApplied(raw.trim());
  }, []);

  const applySearch = () => {
    commitSearch(query);
  };

  const onCopyMatchingNames = async () => {
    setError(null);
    setCopyNamesNote(null);
    setCopyNamesBusy(true);
    try {
      const page = await replicateModelsListCached({
        query: queryApplied || undefined,
        sort,
        enabled: enabledFilter,
        offset: 0,
        limit: null,
      });
      const lines = page.rows.map((r) => `${r.owner}/${r.name}`);
      const text = lines.join("\n");
      if (!text) {
        setCopyNamesNote("Nothing to copy");
        return;
      }
      await copyTextToClipboard(text);
      setCopyNamesNote(`Copied ${lines.length.toLocaleString()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Clipboard denials are noisy — keep them out of the global status error.
      if (/not allowed|denied|rejected|clipboard/i.test(message)) {
        setCopyNamesNote("Copy failed — try again");
      } else {
        setError(message);
      }
    } finally {
      setCopyNamesBusy(false);
    }
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
      applyDetail(d);
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
      if (enabledFilter !== "all") {
        // Row may leave the current filter — reload instead of patching.
        invalidateList();
      } else {
        for (const [index, row] of rowCacheRef.current) {
          if (row.owner === d.owner && row.name === d.name) {
            rowCacheRef.current.set(index, { ...row, enabled: d.enabled });
          }
        }
        setRowCacheVersion((v) => v + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRun = async () => {
    if (!selected || !detail) return;
    const missingText = formFields.filter(
      (f) =>
        !isAnyFileField(f) &&
        f.required &&
        !(runValues[f.name] ?? "").trim(),
    );
    const missingFiles = formFields.filter(
      (f) => isFileField(f) && f.required && !runFilePicks[f.name],
    );
    const missingFileLists = formFields.filter(
      (f) =>
        isFileArrayField(f) &&
        f.required &&
        (runFileListPicks[f.name]?.length ?? 0) === 0,
    );
    const missing = [...missingText, ...missingFiles, ...missingFileLists];
    if (missing.length > 0) {
      setRunError(
        `Required: ${missing.map((f) => f.title || f.name).join(", ")}`,
      );
      return;
    }

    const count = Math.max(1, Math.min(BATCH_MAX, Math.round(batchCount) || 1));
    if (count > 1) {
      const ok = await confirm({
        title: `Run ${count} times?`,
        message: `Submit ${count} predictions for ${selected.owner}/${selected.name}. Outputs appear as each finishes.`,
        confirmLabel: `Run ${count}`,
      });
      if (!ok) return;
    }

    setRunError(null);
    setRunBusy(true);
    setRunProgress(null);
    batchDoneRef.current = 0;
    const slots: RunSlot[] = Array.from({ length: count }, (_, id) => ({
      id,
      status: "pending" as const,
    }));
    setRunSlots(slots);

    try {
      const input = buildRunInput(
        formFields.filter((f) => !isAnyFileField(f)),
        runValues,
      );
      const localFiles: Record<string, string | string[]> = {};
      for (const field of formFields) {
        if (isFileField(field)) {
          const pick = runFilePicks[field.name];
          if (!pick) continue;
          localFiles[field.name] = await resolvePickToPath(
            pick,
            allPickerCreations,
          );
          continue;
        }
        if (isFileArrayField(field)) {
          const list = runFileListPicks[field.name];
          if (!list?.length) continue;
          const paths: string[] = [];
          for (const pick of list) {
            paths.push(await resolvePickToPath(pick, allPickerCreations));
          }
          localFiles[field.name] = paths;
        }
      }

      const patchSlot = (id: number, patch: Partial<RunSlot>) => {
        setRunSlots((prev) =>
          prev.map((slot) => (slot.id === id ? { ...slot, ...patch } : slot)),
        );
      };

      const finals: RunSlot[] = slots.map((s) => ({ ...s }));
      let nextIndex = 0;
      let inFlight = 0;
      let lastStartAt = 0;

      await new Promise<void>((resolve) => {
        const pump = () => {
          while (inFlight < BATCH_MAX_IN_FLIGHT && nextIndex < count) {
            const now = Date.now();
            const wait = Math.max(0, BATCH_STAGGER_MS - (now - lastStartAt));
            if (wait > 0 && inFlight > 0) {
              window.setTimeout(pump, wait);
              return;
            }
            const slotId = nextIndex;
            nextIndex += 1;
            inFlight += 1;
            lastStartAt = Date.now();
            finals[slotId] = { id: slotId, status: "running" };
            patchSlot(slotId, { status: "running", error: undefined });
            void replicateModelRun(
              selected.owner,
              selected.name,
              input,
              localFiles,
            )
              .then((result) => {
                finals[slotId] = { id: slotId, status: "ready", result };
                patchSlot(slotId, { status: "ready", result });
              })
              .catch((err) => {
                const message = formatRunError(
                  err instanceof Error ? err.message : String(err),
                );
                finals[slotId] = { id: slotId, status: "error", error: message };
                patchSlot(slotId, { status: "error", error: message });
              })
              .finally(() => {
                inFlight -= 1;
                batchDoneRef.current += 1;
                if (batchDoneRef.current >= count) {
                  resolve();
                  return;
                }
                pump();
              });
          }
          if (nextIndex >= count && inFlight === 0) {
            resolve();
          }
        };
        pump();
      });

      const failed = finals.filter((s) => s.status === "error");
      if (failed.length === finals.length && failed[0]?.error) {
        setRunError(failed[0].error);
      } else if (failed.length > 0) {
        setRunError(
          `${failed.length} of ${finals.length} runs failed. See slots below.`,
        );
      }
    } catch (err) {
      setRunError(
        formatRunError(err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setRunBusy(false);
    }
  };

  const onCancelRun = async () => {
    try {
      await replicateModelRunCancel();
    } catch (err) {
      setRunError(
        formatRunError(err instanceof Error ? err.message : String(err)),
      );
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

            {hasCatalog ? (
              <>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={copyNamesBusy || listLoading || total === 0}
                  title="Copy owner/name for every model in the current search and Show filter"
                  onClick={() => void onCopyMatchingNames()}
                >
                  {copyNamesBusy ? "Copying…" : "Copy names"}
                </button>
                {copyNamesNote ? (
                  <span className="muted lab-replicate-copy-note">
                    {copyNamesNote}
                  </span>
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
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            if (!next.trim() && queryApplied) {
              setCopyNamesNote(null);
              setQueryApplied("");
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitSearch(e.currentTarget.value);
          }}
          placeholder="Filter local catalog (owner, name, description)"
          aria-label="Filter catalog"
        />
        <button type="button" className="btn ghost" onClick={applySearch}>
          Search
        </button>
        <label className="lab-replicate-sort">
          <span className="muted">Show</span>
          <select
            className="control"
            value={enabledFilter}
            onChange={(e) => {
              setCopyNamesNote(null);
              setEnabledFilter(e.target.value as EnabledFilterId);
            }}
            aria-label="Filter by enabled"
          >
            {ENABLED_FILTER_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="lab-replicate-sort">
          <span className="muted">Sort</span>
          <select
            className="control"
            value={sort}
            onChange={(e) => {
              setCopyNamesNote(null);
              setSort(e.target.value as SortId);
            }}
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
              resetKey={`${queryApplied}|${enabledFilter}|${sort}`}
              loading={listLoading || !statsReady}
              onVisibleRange={onVisibleRange}
              onSelect={(r) => {
                selectModel(r.owner, r.name);
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
                <div className="lab-replicate-detail-loading is-with-close">
                  <ReplicateDetailClose onClick={closeDetail} />
                  <p className="muted">Loading…</p>
                </div>
              ) : (
                <>
                  <header className="lab-replicate-detail-header">
                    {detail.coverImageUrl ? (
                      <div className="lab-replicate-detail-cover-wrap">
                        <img
                          className="lab-replicate-detail-cover"
                          src={detail.coverImageUrl}
                          alt=""
                          referrerPolicy="no-referrer"
                        />
                        <ReplicateDetailClose onClick={closeDetail} overlay />
                      </div>
                    ) : (
                      <ReplicateDetailClose onClick={closeDetail} />
                    )}
                    <h3>
                      {detail.owner}/{detail.name}
                    </h3>
                    <p className="lab-replicate-detail-links">
                      <button
                        type="button"
                        className="lab-replicate-external-link"
                        onClick={() => {
                          void openUrl(replicateModelPageUrl(detail));
                        }}
                      >
                        Open on Replicate
                      </button>
                    </p>
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
                        disabled={busy || runBusy}
                        onClick={() => void onToggleEnabled()}
                      >
                        {detail.enabled ? "Disable model" : "Enable model"}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={busy || runBusy || !stats?.tokenConfigured}
                        onClick={() => void onUpdateModel()}
                      >
                        Update model
                      </button>
                      {!detail.enabled ? (
                        <span className="muted">
                          Enable to open the run form for this model.
                        </span>
                      ) : null}
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

                  {detail.enabled ? (
                    <section className="lab-replicate-run">
                      <h4>Run</h4>
                      {!detail.schemaCached || formFields.length === 0 ? (
                        <p className="muted">
                          No runnable schema yet — use Update model to fetch
                          OpenAPI.
                        </p>
                      ) : (
                        <form
                          className="lab-replicate-run-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void onRun();
                          }}
                        >
                          {formFields.map((field) => {
                            const label = field.title || field.name;
                            const value = runValues[field.name] ?? "";
                            const enums = field.enumValues ?? null;
                            const setValue = (next: string) =>
                              setRunValues((prev) => ({
                                ...prev,
                                [field.name]: next,
                              }));
                            const kind = isAnyFileField(field)
                              ? fileFieldKind(field)
                              : null;
                            const isPromptLike =
                              field.typeName === "string" &&
                              !enums?.length &&
                              !isAnyFileField(field) &&
                              (field.name.toLowerCase().includes("prompt") ||
                                (field.description?.length ?? 0) > 80);
                            const showSlider = hasSliderRange(field);
                            const defaultLabel = formatDefaultLabel(field);
                            const rangeLabel =
                              field.minimum != null && field.maximum != null
                                ? `(minimum: ${field.minimum}, maximum: ${field.maximum})`
                                : null;

                            if (isFileArrayField(field) && kind) {
                              const list = runFileListPicks[field.name] ?? [];
                              return (
                                <div
                                  key={field.name}
                                  className="lab-replicate-run-field"
                                >
                                  <div className="lab-replicate-run-field-head">
                                    <span>
                                      <span className="lab-replicate-run-field-name">
                                        {field.name}
                                      </span>
                                      <span className="muted">
                                        {" "}
                                        {fileFieldLabel(kind)} array
                                        {field.required ? " · required" : ""}
                                      </span>
                                    </span>
                                  </div>
                                  {label !== field.name ? (
                                    <div className="muted lab-replicate-run-field-title">
                                      {label}
                                    </div>
                                  ) : null}
                                  <div className="lab-replicate-file-list">
                                    {list.length === 0 ? (
                                      <p className="muted lab-replicate-file-list-empty">
                                        No files added yet.
                                      </p>
                                    ) : (
                                      list.map((item, index) => {
                                        const selectedCreation =
                                          item.kind === "creation"
                                            ? allPickerCreations.get(
                                                item.creationId,
                                              )
                                            : undefined;
                                        const thumb =
                                          selectedCreation &&
                                          (selectedCreation.mediaType ===
                                            "image" ||
                                            selectedCreation.mediaType ===
                                              "video")
                                            ? creationPreviewUrl(
                                                selectedCreation,
                                              )
                                            : null;
                                        const labelText = pickLabel(
                                          item,
                                          allPickerCreations,
                                        );
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
                                                  {kind === "audio"
                                                    ? "♪"
                                                    : kind === "video"
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
                                                  : labelText
                                              }
                                            >
                                              {labelText}
                                              {item.kind === "path" ? (
                                                <span className="muted">
                                                  {" "}
                                                  · local
                                                </span>
                                              ) : null}
                                            </span>
                                            <button
                                              type="button"
                                              className="btn ghost"
                                              disabled={runBusy}
                                              onClick={() =>
                                                removeRunFileListItem(
                                                  field.name,
                                                  index,
                                                )
                                              }
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
                                        setLibraryPicker({
                                          fieldName: field.name,
                                          mode: "append",
                                        })
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
                                            const path =
                                              await replicatePickLocalFile(
                                                kind,
                                              );
                                            if (path) {
                                              appendRunFileListItem(
                                                field.name,
                                                { kind: "path", path },
                                              );
                                            }
                                          } catch (err) {
                                            setRunError(
                                              formatRunError(
                                                err instanceof Error
                                                  ? err.message
                                                  : String(err),
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
                                        onClick={() =>
                                          setRunFileListForField(field.name, [])
                                        }
                                      >
                                        Clear all
                                      </button>
                                    ) : null}
                                  </div>
                                  {field.description ? (
                                    <p className="muted lab-replicate-run-help">
                                      {field.description}
                                    </p>
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
                              const chooseLibraryLabel = "Choose from Library";
                              return (
                                <div
                                  key={field.name}
                                  className="lab-replicate-run-field"
                                >
                                  <div className="lab-replicate-run-field-head">
                                    <span>
                                      <span className="lab-replicate-run-field-name">
                                        {field.name}
                                      </span>
                                      <span className="muted">
                                        {" "}
                                        {fileFieldLabel(kind)}
                                        {field.required ? " · required" : ""}
                                      </span>
                                    </span>
                                  </div>
                                  {label !== field.name ? (
                                    <div className="muted lab-replicate-run-field-title">
                                      {label}
                                    </div>
                                  ) : null}
                                  <div className="lab-replicate-image-pick-row">
                                    {pick ? (
                                      <div className="lab-replicate-image-chosen">
                                        {kind === "image" ||
                                        kind === "video" ||
                                        kind === "any" ? (
                                          <button
                                            type="button"
                                            className="lab-replicate-image-chosen-thumb"
                                            disabled={runBusy}
                                            title="Choose another file"
                                            onClick={() =>
                                              setLibraryPicker({ fieldName: field.name, mode: "single" })
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
                                          title={
                                            pick.kind === "path"
                                              ? pick.path
                                              : chosenLabel
                                          }
                                        >
                                          {chosenLabel}
                                          {pick.kind === "path" ? (
                                            <span className="muted">
                                              {" "}
                                              · local
                                            </span>
                                          ) : null}
                                        </span>
                                        <button
                                          type="button"
                                          className="btn ghost"
                                          disabled={runBusy}
                                          onClick={() =>
                                            setLibraryPicker({ fieldName: field.name, mode: "single" })
                                          }
                                        >
                                          {chooseLibraryLabel}
                                        </button>
                                        <button
                                          type="button"
                                          className="btn ghost"
                                          disabled={runBusy}
                                          onClick={() => {
                                            void (async () => {
                                              try {
                                                const path =
                                                  await replicatePickLocalFile(
                                                    kind,
                                                  );
                                                if (path) {
                                                  setRunFileForField(
                                                    field.name,
                                                    { kind: "path", path },
                                                  );
                                                }
                                              } catch (err) {
                                                setRunError(
                                                  formatRunError(
                                                    err instanceof Error
                                                      ? err.message
                                                      : String(err),
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
                                          onClick={() =>
                                            setRunFileForField(field.name, null)
                                          }
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
                                            setLibraryPicker({ fieldName: field.name, mode: "single" })
                                          }
                                        >
                                          {chooseLibraryLabel}
                                        </button>
                                        <button
                                          type="button"
                                          className="btn ghost"
                                          disabled={runBusy}
                                          onClick={() => {
                                            void (async () => {
                                              try {
                                                const path =
                                                  await replicatePickLocalFile(
                                                    kind,
                                                  );
                                                if (path) {
                                                  setRunFileForField(
                                                    field.name,
                                                    { kind: "path", path },
                                                  );
                                                }
                                              } catch (err) {
                                                setRunError(
                                                  formatRunError(
                                                    err instanceof Error
                                                      ? err.message
                                                      : String(err),
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
                                    <p className="muted lab-replicate-run-help">
                                      {field.description}
                                    </p>
                                  ) : null}
                                </div>
                              );
                            }

                            const aspectOptions =
                              aspectChooserOptionsForField(field);
                            if (aspectOptions.length > 0) {
                              const aspectValue = pickAspectChooserValue(
                                aspectOptions,
                                value,
                              );
                              return (
                                <div
                                  key={field.name}
                                  className="lab-replicate-run-field"
                                >
                                  <div className="lab-replicate-run-field-head">
                                    <span>
                                      <span className="lab-replicate-run-field-name">
                                        {field.name}
                                      </span>
                                      <span className="muted">
                                        {" "}
                                        {field.typeName}
                                        {field.required ? " · required" : ""}
                                      </span>
                                    </span>
                                  </div>
                                  <AspectRatioChooser
                                    value={aspectValue}
                                    options={aspectOptions}
                                    disabled={runBusy}
                                    onChange={setValue}
                                  />
                                  {field.description ? (
                                    <p className="muted lab-replicate-run-help">
                                      {field.description}
                                    </p>
                                  ) : null}
                                  {defaultLabel != null ? (
                                    <p className="muted lab-replicate-run-default">
                                      Default: {defaultLabel}
                                    </p>
                                  ) : null}
                                </div>
                              );
                            }

                            return (
                              <div
                                key={field.name}
                                className="lab-replicate-run-field"
                              >
                                {field.typeName === "boolean" ? (
                                  <label className="lab-replicate-run-check">
                                    <input
                                      type="checkbox"
                                      checked={value === "true"}
                                      disabled={runBusy}
                                      onChange={(e) =>
                                        setValue(
                                          e.target.checked ? "true" : "false",
                                        )
                                      }
                                    />
                                    <span>
                                      <span className="lab-replicate-run-field-name">
                                        {field.name}
                                      </span>
                                      <span className="muted">
                                        {" "}
                                        {field.typeName}
                                        {field.required ? " · required" : ""}
                                      </span>
                                    </span>
                                  </label>
                                ) : (
                                  <>
                                    <div className="lab-replicate-run-field-head">
                                      <span>
                                        <span className="lab-replicate-run-field-name">
                                          {field.name}
                                        </span>
                                        <span className="muted">
                                          {" "}
                                          {field.typeName}
                                          {field.required ? " · required" : ""}
                                        </span>
                                      </span>
                                      {rangeLabel ? (
                                        <span className="muted lab-replicate-run-range-label">
                                          {rangeLabel}
                                        </span>
                                      ) : null}
                                    </div>
                                    {label !== field.name ? (
                                      <div className="muted lab-replicate-run-field-title">
                                        {label}
                                      </div>
                                    ) : null}

                                    {enums && enums.length > 0 ? (
                                      <select
                                        className="control"
                                        value={value}
                                        disabled={runBusy}
                                        onChange={(e) =>
                                          setValue(e.target.value)
                                        }
                                      >
                                        {!field.required && !value ? (
                                          <option value="">(default)</option>
                                        ) : null}
                                        {enums.map((opt) => (
                                          <option key={opt} value={opt}>
                                            {opt}
                                          </option>
                                        ))}
                                      </select>
                                    ) : isPromptLike ? (
                                      <textarea
                                        className="control"
                                        rows={3}
                                        value={value}
                                        disabled={runBusy}
                                        onChange={(e) =>
                                          setValue(e.target.value)
                                        }
                                      />
                                    ) : field.typeName === "integer" ||
                                      field.typeName === "number" ? (
                                      showSlider ? (
                                        <div className="lab-replicate-run-slider-row">
                                          <input
                                            className="control lab-replicate-run-number"
                                            type="number"
                                            min={field.minimum ?? undefined}
                                            max={field.maximum ?? undefined}
                                            step={sliderStep(field)}
                                            value={value}
                                            disabled={runBusy}
                                            onChange={(e) =>
                                              setValue(
                                                clampNumericString(
                                                  e.target.value,
                                                  field,
                                                ),
                                              )
                                            }
                                          />
                                          <input
                                            className="lab-replicate-run-range"
                                            type="range"
                                            min={field.minimum!}
                                            max={field.maximum!}
                                            step={sliderStep(field)}
                                            value={
                                              Number.isFinite(Number(value))
                                                ? Number(value)
                                                : (field.minimum ?? 0)
                                            }
                                            disabled={runBusy}
                                            onChange={(e) =>
                                              setValue(e.target.value)
                                            }
                                          />
                                        </div>
                                      ) : (
                                        <input
                                          className="control"
                                          type="number"
                                          min={field.minimum ?? undefined}
                                          max={field.maximum ?? undefined}
                                          step={
                                            field.typeName === "integer"
                                              ? 1
                                              : "any"
                                          }
                                          value={value}
                                          disabled={runBusy}
                                          onChange={(e) =>
                                            setValue(e.target.value)
                                          }
                                        />
                                      )
                                    ) : (
                                      <input
                                        className="control"
                                        type="text"
                                        value={value}
                                        disabled={runBusy}
                                        onChange={(e) =>
                                          setValue(e.target.value)
                                        }
                                      />
                                    )}
                                  </>
                                )}

                                {field.description ? (
                                  <p className="muted lab-replicate-run-help">
                                    {field.description}
                                  </p>
                                ) : null}
                                {defaultLabel != null ? (
                                  <p className="muted lab-replicate-run-default">
                                    Default: {defaultLabel}
                                  </p>
                                ) : null}
                              </div>
                            );
                          })}
                          <div className="lab-replicate-run-actions">
                            <label className="lab-replicate-batch-count">
                              <span className="muted">Batch</span>
                              <input
                                className="control lab-replicate-batch-count-input"
                                type="number"
                                min={1}
                                max={BATCH_MAX}
                                step={1}
                                value={batchCount}
                                disabled={runBusy}
                                aria-label="Batch count"
                                onChange={(e) => {
                                  const n = Number(e.target.value);
                                  if (!Number.isFinite(n)) {
                                    setBatchCount(1);
                                    return;
                                  }
                                  setBatchCount(
                                    Math.max(1, Math.min(BATCH_MAX, Math.round(n))),
                                  );
                                }}
                              />
                            </label>
                            <button
                              type="submit"
                              className="btn primary"
                              disabled={
                                runBusy ||
                                busy ||
                                !stats?.tokenConfigured ||
                                !detail.schemaCached
                              }
                            >
                              {runBusy
                                ? batchCount > 1
                                  ? `Running ${runSlots.filter((s) => s.status === "ready" || s.status === "error").length}/${batchCount}…`
                                  : "Running…"
                                : batchCount > 1
                                  ? `Run ${batchCount}`
                                  : "Run"}
                            </button>
                            {runBusy ? (
                              <button
                                type="button"
                                className="btn ghost"
                                onClick={() => void onCancelRun()}
                              >
                                Cancel
                              </button>
                            ) : null}
                          </div>
                        </form>
                      )}
                      {runProgress && !runProgress.done ? (
                        <p className="muted lab-replicate-run-status">
                          {runProgress.message || runProgress.status}
                        </p>
                      ) : null}
                      {runError ? (
                        <div className="lab-replicate-run-outputs">
                          <h4>Error</h4>
                          <pre className="lab-replicate-pred-json lab-replicate-run-error">
                            {runError}
                          </pre>
                        </div>
                      ) : null}
                      {runSlots.length > 0 ? (
                        <div className="lab-replicate-run-outputs">
                          <h4>
                            Output
                            {runSlots.length > 1
                              ? ` (${runSlots.filter((s) => s.status === "ready").length}/${runSlots.length})`
                              : ""}
                          </h4>
                          <div className="lab-replicate-batch-grid">
                            {runSlots.map((slot) => {
                              const slotStyle = batchSlotAspectCss
                                ? ({
                                    aspectRatio: batchSlotAspectCss,
                                  } as const)
                                : undefined;
                              const slotClass = [
                                "lab-replicate-batch-slot",
                                batchSlotAspectCss ? "has-aspect" : "",
                              ]
                                .filter(Boolean)
                                .join(" ");
                              if (slot.status === "ready" && slot.result) {
                                const paths = slot.result.localPaths;
                                if (paths.length > 0) {
                                  return (
                                    <div
                                      key={slot.id}
                                      className={`${slotClass} is-ready`}
                                      style={slotStyle}
                                    >
                                      {paths.map((path) => (
                                        <ReplicateLocalOutput
                                          key={path}
                                          path={path}
                                          showPath={false}
                                          onActivate={() =>
                                            void openOutputLightbox(path)
                                          }
                                          activating={activatingPath === path}
                                        />
                                      ))}
                                    </div>
                                  );
                                }
                                if (slot.result.outputPreview) {
                                  return (
                                    <div
                                      key={slot.id}
                                      className={`${slotClass} is-ready`}
                                      style={slotStyle}
                                    >
                                      <pre className="lab-replicate-pred-json">
                                        {slot.result.outputPreview}
                                      </pre>
                                    </div>
                                  );
                                }
                              }
                              if (slot.status === "error") {
                                return (
                                  <div
                                    key={slot.id}
                                    className={`${slotClass} is-error`}
                                    style={slotStyle}
                                  >
                                    <span className="muted">
                                      #{slot.id + 1} failed
                                    </span>
                                    <pre className="lab-replicate-pred-json lab-replicate-run-error">
                                      {slot.error}
                                    </pre>
                                  </div>
                                );
                              }
                              return (
                                <div
                                  key={slot.id}
                                  className={`${slotClass} is-${slot.status}`}
                                  style={slotStyle}
                                  aria-busy={
                                    slot.status === "pending" ||
                                    slot.status === "running"
                                  }
                                >
                                  <span className="lab-replicate-batch-placeholder">
                                    {slot.status === "running"
                                      ? `Running #${slot.id + 1}…`
                                      : `Waiting #${slot.id + 1}`}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </section>
                  ) : detail.inputs.length > 0 ? (
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
                              {f.fileLike ? " · file" : ""}
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
            {(queryApplied || enabledFilter !== "all") &&
            total !== (stats?.modelCount ?? -1) ? (
              <> · matching {total.toLocaleString()}</>
            ) : null}
            {listLoading ? " · loading…" : null}
            {listTiming ? (
              <>
                {" "}
                · list {listTiming.total}ms
                {listTiming.indexLoad > 0
                  ? ` (index ${listTiming.indexLoad}ms)`
                  : listTiming.cacheHit
                    ? " (cached)"
                    : ""}
                {listTiming.sort > 0 ? ` · sort ${listTiming.sort}ms` : ""}
              </>
            ) : null}
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

      {libraryPicker ? (
        <LibraryFilePickerDialog
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
            const pick: RunFilePick = { kind: "creation", creationId: id };
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

function LibraryFilePickerDialog({
  fieldName,
  field,
  pick,
  pickerImages,
  pickerAudio,
  pickerVideo,
  onClose,
  onPickCreation,
}: {
  fieldName: string;
  field: ReplicateInputField | null;
  pick: RunFilePick | null;
  pickerImages: Creation[];
  pickerAudio: Creation[];
  pickerVideo: Creation[];
  onClose: () => void;
  onPickCreation: (id: string) => void;
}) {
  const kind = field ? fileFieldKind(field) : "any";
  const selectedId = pick?.kind === "creation" ? pick.creationId : "";
  const title =
    kind === "audio"
      ? "Choose audio"
      : kind === "video"
        ? "Choose video"
        : kind === "image"
          ? "Choose image"
          : "Choose file";

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="confirm-dialog lab-replicate-image-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lab-replicate-file-picker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="lab-replicate-file-picker-title">{title}</h2>
        <p className="muted">
          Pick a Library asset for <code>{fieldName}</code>. Local disk files
          can be chosen from the run form without opening this dialog.
        </p>
        <div className="lab-replicate-image-picker-body">
          {kind === "image" || kind === "any" ? (
            <LabImagePicker
              images={
                kind === "any"
                  ? [...pickerImages, ...pickerVideo]
                  : pickerImages
              }
              value={selectedId}
              mediaLabel={
                kind === "any" ? "Library images & videos" : "Library images"
              }
              onChange={onPickCreation}
            />
          ) : null}
          {kind === "audio" || kind === "any" ? (
            <div className="lab-replicate-audio-list">
              {pickerAudio.length === 0 ? (
                kind === "audio" ? (
                  <p className="muted">No audio in Library or this project.</p>
                ) : null
              ) : (
                <label className="lab-replicate-run-field">
                  <span className="lab-replicate-run-field-name">Audio</span>
                  <select
                    className="control"
                    value={
                      pickerAudio.some((c) => c.id === selectedId)
                        ? selectedId
                        : ""
                    }
                    onChange={(e) => {
                      const id = e.target.value;
                      if (id) onPickCreation(id);
                    }}
                    aria-label="Library audio"
                  >
                    <option value="">Select audio…</option>
                    {pickerAudio.map((c) => (
                      <option key={c.id} value={c.id}>
                        {creationCardTitle(c).text}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          ) : null}
          {kind === "video" ? (
            <LabImagePicker
              images={pickerVideo}
              value={selectedId}
              mediaLabel="Library videos"
              onChange={onPickCreation}
            />
          ) : null}
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
