/** Thin invoke wrappers for Parascene Blue direct — Settings + Lab. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ReplicateInputField,
  ReplicateModelDetail,
  ReplicateModelListPage,
  ReplicateModelRow,
  ReplicatePredictionDetail,
  ReplicatePredictionListRow,
  ReplicatePredictionRecord,
  ReplicateRunProgressEvent,
  ReplicateRunResult,
} from "../replicate/replicateClient";

export type BlueCredentialsStatus = {
  configured: boolean;
  preview?: string | null;
};

export async function blueCredentialsStatus(): Promise<BlueCredentialsStatus> {
  return invoke("blue_credentials_status");
}

export async function blueCredentialsSet(
  credentialsJson: string,
): Promise<BlueCredentialsStatus> {
  return invoke("blue_credentials_set", { credentialsJson });
}

export async function blueCredentialsClear(): Promise<BlueCredentialsStatus> {
  return invoke("blue_credentials_clear");
}

export type BlueCapabilities = {
  status?: string;
  methods?: Record<string, BlueMethodDef>;
  capability_matrix?: BlueCapabilityRow[];
  retention?: unknown;
  [key: string]: unknown;
};

export type BlueMethodDef = {
  id?: string;
  name?: string;
  description?: string;
  intent?: string;
  credits?: number;
  async?: boolean;
  default?: boolean;
  fields?: Record<string, BlueFieldDef>;
};

export type BlueFieldDef = {
  label?: string;
  type?: string;
  required?: boolean;
  description?: string;
  hint?: string;
  default?: unknown;
  min?: number;
  max?: number;
  hidden?: boolean;
  options?: Array<{ label?: string; value?: string; hint?: string }>;
};

export type BlueCapabilityRow = {
  method?: string;
  model?: string;
  family?: string;
  capabilities?: string[];
  [key: string]: unknown;
};

export async function blueCapabilities(): Promise<BlueCapabilities> {
  return invoke("blue_capabilities");
}

export async function blueUploadFile(path: string): Promise<string> {
  return invoke("blue_upload_file", { path });
}

export async function blueMethodRun(
  method: string,
  args: Record<string, unknown>,
  localFiles?: Record<string, string | string[]>,
): Promise<ReplicateRunResult> {
  const files = localFiles ?? null;
  return invoke("blue_method_run", {
    method,
    args,
    localFiles: files,
    localFilesJson: files ? JSON.stringify(files) : null,
  });
}

export async function blueMethodRunCancel(): Promise<void> {
  return invoke("blue_method_run_cancel");
}

export async function blueJobsList(opts?: {
  status?: string | null;
  query?: string | null;
}): Promise<ReplicatePredictionListRow[]> {
  return invoke("blue_jobs_list", {
    status: opts?.status ?? null,
    query: opts?.query ?? null,
  });
}

/** Blue stores `jobId` on disk; Lab UI shares Replicate’s `predictionId` shape. */
function normalizeBlueDetail(
  detail: ReplicatePredictionDetail | null,
): ReplicatePredictionDetail | null {
  if (!detail?.record) return detail;
  const record = detail.record as ReplicatePredictionRecord & {
    jobId?: string;
  };
  const predictionId = record.predictionId?.trim() || record.jobId?.trim();
  if (!predictionId || predictionId === record.predictionId) return detail;
  return {
    ...detail,
    record: { ...record, predictionId },
  };
}

export async function blueJobGet(
  predictionId: string,
): Promise<ReplicatePredictionDetail | null> {
  const detail = await invoke<ReplicatePredictionDetail | null>("blue_job_get", {
    predictionId,
  });
  return normalizeBlueDetail(detail);
}

export async function blueJobWait(
  predictionId: string,
): Promise<ReplicateRunResult> {
  return invoke("blue_job_wait", { predictionId });
}

export async function blueJobDownload(
  predictionId: string,
): Promise<ReplicateRunResult> {
  return invoke("blue_job_download", { predictionId });
}

/** Delete local Lab Blue job history + cached outputs. */
export async function blueJobDelete(predictionId: string): Promise<void> {
  return invoke("blue_job_delete", { predictionId });
}

export async function listenBlueRunProgress(
  handler: (ev: ReplicateRunProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<ReplicateRunProgressEvent>("blue-run-progress", (e) => {
    handler(e.payload);
  });
}

/** Map Blue GET /api methods into Replicate Lab list rows. */
export type BlueMethodOutputKind = "image" | "video" | "other";

/**
 * Distinct thumb fills ordered by hue around the wheel (~30° steps, then a
 * second ring offset) so list assignment can maximize separation.
 * Solid hex for older WebKit (no color-mix).
 */
const BLUE_METHOD_THUMB_PASTELS = [
  "#f07167", // red
  "#f4a261", // orange
  "#e9c46a", // yellow
  "#b5c96b", // chartreuse
  "#5ecf8e", // green
  "#48b5c4", // cyan
  "#4ea8de", // sky
  "#748ffc", // soft blue
  "#7b68ee", // medium slate blue
  "#9b5de5", // violet
  "#f15bb5", // magenta
  "#ef476f", // rose
  // Second ring — lighter / shifted for more slots without clustering peach
  "#ff8fab", // pink
  "#ffb347", // amber
  "#ffe066", // bright yellow
  "#8ce99a", // light green
  "#63e6be", // mint
  "#66d9e8", // light cyan
  "#74c0fc", // light blue
  "#9775fa", // soft indigo
  "#da77f2", // orchid
  "#f783ac", // light rose
  "#ffa94d", // vivid apricot
  "#94d82d", // lime
] as const;

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable pastel for a single method id (may collide across many ids). */
export function blueMethodThumbColor(methodId: string): string {
  const idx =
    hashString(methodId.trim().toLowerCase()) % BLUE_METHOD_THUMB_PASTELS.length;
  return BLUE_METHOD_THUMB_PASTELS[idx]!;
}

function paletteRingDistance(a: number, b: number, n: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, n - d);
}

/**
 * Hash-seeded colors with max-separation fill so every name in `methodIds`
 * gets a distinct, visually spread hue while the set fits in the palette.
 */
export function blueMethodThumbColors(
  methodIds: readonly string[],
): Map<string, string> {
  const used = new Set<number>();
  const out = new Map<string, string>();
  const n = BLUE_METHOD_THUMB_PASTELS.length;
  for (const id of methodIds) {
    const key = id.trim().toLowerCase() || id;
    const preferred = hashString(key) % n;
    let best: number = preferred;
    let bestScore = -1;
    for (let i = 0; i < n; i++) {
      if (used.has(i)) continue;
      let minDist: number = n;
      for (const u of used) {
        minDist = Math.min(minDist, paletteRingDistance(i, u, n));
      }
      if (used.size === 0) minDist = n;
      // Prefer hash pick when tied so colors stay stable across reorders.
      const score = minDist * 100 + (i === preferred ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    used.add(best);
    out.set(id, BLUE_METHOD_THUMB_PASTELS[best]!);
  }
  return out;
}

/** Infer list/detail grouping from method id, intent, or capability tags. */
export function blueMethodOutputKind(args: {
  name: string;
  intent?: string | null;
  features?: string[];
}): BlueMethodOutputKind {
  const intent = (args.intent ?? "").toLowerCase();
  if (intent.startsWith("image_") || intent.includes("image")) return "image";
  if (intent.startsWith("video_") || intent.includes("video")) return "video";

  const name = args.name.toLowerCase();
  if (name.endsWith("2image") || name.includes("image2image")) return "image";
  if (
    name.endsWith("2video") ||
    name.includes("video2video") ||
    name.includes("audio2video")
  ) {
    return "video";
  }

  const feat = (args.features ?? []).join(" ").toLowerCase();
  if (/\b(i2i|t2i|image_generate|image_mutate)\b/.test(feat)) return "image";
  if (/\b(t2v|i2v|a2v|v2v|r2v|video_generate)\b/.test(feat)) return "video";
  return "other";
}

function outputKindSortKey(kind: BlueMethodOutputKind): number {
  if (kind === "image") return 0;
  if (kind === "video") return 1;
  return 2;
}

/**
 * Secondary sort: source modality from the token before `2` in `text2image`,
 * `reference2video`, etc. — text → image → audio → ref → video.
 */
export function blueMethodInputSortKey(name: string): number {
  const n = name.trim().toLowerCase();
  const idx = n.indexOf("2");
  const raw = idx >= 0 ? n.slice(0, idx) : n;
  const prefix = raw.replace(/[^a-z]/g, "");
  if (prefix.startsWith("text")) return 0;
  if (prefix.startsWith("image")) return 1;
  if (prefix.startsWith("audio")) return 2;
  if (prefix.startsWith("ref")) return 3;
  if (prefix.startsWith("video")) return 4;
  return 5;
}

export function blueCapabilitiesToListPage(
  caps: BlueCapabilities,
  query?: string,
): ReplicateModelListPage {
  const methods = caps.methods ?? {};
  const q = query?.trim().toLowerCase() ?? "";
  const rows: ReplicateModelRow[] = Object.entries(methods)
    .map(([id, def]) => {
      const name = (def.id || id).trim() || id;
      const title = def.name?.trim() || name;
      const description = def.description?.trim() || null;
      const features: string[] = [];
      if (def.intent) features.push(def.intent);
      if (def.async) features.push("async");
      const matrix = Array.isArray(caps.capability_matrix)
        ? caps.capability_matrix.filter((r) => r.method === name)
        : [];
      for (const row of matrix) {
        for (const c of row.capabilities ?? []) {
          if (c && !features.includes(c)) features.push(c);
        }
      }
      return {
        owner: "blue",
        name,
        description: description || title,
        runCount: 0,
        coverImageUrl: null,
        latestVersionId: null,
        features,
        schemaCached: true,
        url: null,
        enabled: true,
      } satisfies ReplicateModelRow;
    })
    .filter((row) => {
      if (!q) return true;
      const blob = `${row.name} ${row.description ?? ""} ${row.features.join(" ")}`.toLowerCase();
      return blob.includes(q);
    })
    .sort((a, b) => {
      const ka = outputKindSortKey(
        blueMethodOutputKind({
          name: a.name,
          intent: a.features[0],
          features: a.features,
        }),
      );
      const kb = outputKindSortKey(
        blueMethodOutputKind({
          name: b.name,
          intent: b.features[0],
          features: b.features,
        }),
      );
      if (ka !== kb) return ka - kb;
      const ia = blueMethodInputSortKey(a.name);
      const ib = blueMethodInputSortKey(b.name);
      if (ia !== ib) return ia - ib;
      return a.name.localeCompare(b.name);
    });

  return {
    rows,
    total: rows.length,
    offset: 0,
    limit: rows.length,
    timingMs: null,
  };
}

export function blueMethodToDetail(
  methodId: string,
  def: BlueMethodDef,
  matrix?: BlueCapabilityRow[],
): ReplicateModelDetail {
  const inputs = blueFieldsToInputFields(def.fields ?? {});
  const features: string[] = [];
  if (def.intent) features.push(def.intent);
  if (def.async) features.push("async");
  for (const row of matrix ?? []) {
    if (row.method !== methodId) continue;
    for (const c of row.capabilities ?? []) {
      if (c && !features.includes(c)) features.push(c);
    }
  }
  return {
    owner: "blue",
    name: methodId,
    description: def.description ?? def.name ?? null,
    runCount: 0,
    coverImageUrl: null,
    latestVersionId: null,
    features,
    schemaCached: true,
    enabled: true,
    inputs,
    url: null,
    raw: def,
  };
}

/** Blue method.fields → ReplicateInputField (shared Lab form DTO). */
export function blueFieldsToInputFields(
  fields: Record<string, BlueFieldDef>,
): ReplicateInputField[] {
  const out: ReplicateInputField[] = [];
  for (const [name, field] of Object.entries(fields)) {
    // Lab shows Blue "hidden" fields (aspect_ratio, duration, seed, …) so
    // schema defaults are visible/editable — Blue's create UI may hide them.
    const type = (field.type ?? "text").toLowerCase();
    const title = field.label?.trim() || name;
    const description =
      [field.description, field.hint].filter(Boolean).join(" ").trim() || null;
    const required = field.required === true;
    const defaultValue = resolveBlueFieldDefault(name, type, field, description);

    if (type === "select") {
      const enumValues = (field.options ?? [])
        .map((o) => (typeof o.value === "string" ? o.value : ""))
        .filter(Boolean);
      out.push({
        name,
        title,
        typeName: "string",
        required,
        description,
        format: null,
        defaultValue,
        enumValues: enumValues.length ? enumValues : null,
        minimum: null,
        maximum: null,
        fileLike: false,
        arrayItemFileLike: false,
      });
      continue;
    }

    if (type === "number") {
      out.push({
        name,
        title,
        typeName: "number",
        required,
        description,
        format: null,
        defaultValue,
        enumValues: null,
        minimum: typeof field.min === "number" ? field.min : null,
        maximum: typeof field.max === "number" ? field.max : null,
        fileLike: false,
        arrayItemFileLike: false,
      });
      continue;
    }

    if (type === "boolean") {
      out.push({
        name,
        title,
        typeName: "boolean",
        required,
        description,
        format: null,
        defaultValue,
        enumValues: null,
        minimum: null,
        maximum: null,
        fileLike: false,
        arrayItemFileLike: false,
      });
      continue;
    }

    if (
      type === "image_url_array" ||
      type === "audio_url_array" ||
      type === "video_url_array" ||
      type === "image_url" ||
      type === "audio_url" ||
      type === "video_url"
    ) {
      const isArray = type.endsWith("_array");
      const media = type.includes("audio")
        ? "audio"
        : type.includes("video")
          ? "video"
          : "image";
      out.push({
        name,
        title,
        typeName: isArray ? "array" : "string",
        required,
        description:
          description ||
          `${media} URL(s); Lab uploads local files to Blue /api/files`,
        format: "uri",
        defaultValue,
        enumValues: null,
        minimum: null,
        maximum: null,
        fileLike: !isArray,
        arrayItemFileLike: isArray,
      });
      continue;
    }

    // text / default
    out.push({
      name,
      title,
      typeName: "string",
      required,
      description,
      format: null,
      defaultValue,
      enumValues: null,
      minimum: null,
      maximum: null,
      fileLike: false,
      arrayItemFileLike: false,
    });
  }
  return out;
}

/**
 * Blue often documents numeric defaults in prose instead of `default`.
 * Seed stays unset so omitting it keeps Blue's random-seed behavior.
 */
export function resolveBlueFieldDefault(
  name: string,
  type: string,
  field: BlueFieldDef,
  description: string | null,
): unknown {
  if (field.default !== undefined && field.default !== null) {
    return field.default;
  }
  if (type !== "number") return field.default;
  if (name === "seed") return undefined;

  const fromDesc = parseNumericDefaultFromDescription(description);
  if (fromDesc !== undefined) return fromDesc;

  if (name === "denoise") return 0.65;
  if (name === "duration_seconds") return 9;
  return undefined;
}

/** Pull a concrete number from Blue field descriptions. */
export function parseNumericDefaultFromDescription(
  description: string | null | undefined,
): number | undefined {
  const desc = description?.trim() ?? "";
  if (!desc) return undefined;

  const toMatch = desc.match(/defaults?\s+to\s+(\d+(?:\.\d+)?)/i);
  if (toMatch) {
    const n = Number(toMatch[1]);
    return Number.isFinite(n) ? n : undefined;
  }

  // "default ~5–9" / "default ~5-9" → prefer the upper end (Blue a2v uses 9).
  const range = desc.match(
    /default\s+~?(\d+(?:\.\d+)?)\s*[–-]\s*~?(\d+(?:\.\d+)?)/i,
  );
  if (range) {
    const n = Number(range[2]);
    return Number.isFinite(n) ? n : undefined;
  }

  // "default 9" / "default ~5" — avoid matching "default ~5–9" (handled above).
  const exact = desc.match(/default\s+~?(\d+(?:\.\d+)?)(?!\s*[–-])/i);
  if (exact) {
    const n = Number(exact[1]);
    return Number.isFinite(n) ? n : undefined;
  }

  return undefined;
}
