/**
 * Blue video models for timeline fill — live GET /api capabilities with a
 * checked-in snapshot fallback (same surface as Lab / Blue Methods).
 */

import {
  blueCapabilities,
  type BlueCapabilities,
  type BlueCapabilityRow,
} from "../../blue/blueClient";
import blueCapabilitiesSnapshot from "../../../docs/parascene-blue-api-capabilities.json";
import type { GenerateIntentId } from "./previewIntent";
import type { AddAssetAudioMode, AddAssetContinuityMode } from "./addAssetGenerate";
import {
  DEFAULT_R2V_MODEL_ID,
  DEFAULT_V2V_MODEL_ID,
} from "./generateMediaRefs";
import {
  parasceneProductVideoModelIds,
  parasceneVideoModels,
} from "./parasceneProductCaps";

export type BlueVideoMethod =
  | "text2video"
  | "image2video"
  | "audio2video"
  | "video2video"
  | "reference2video";

export type BlueVideoModelOption = {
  id: string;
  label: string;
  method: BlueVideoMethod;
  flf: boolean;
  nativeAudio: boolean;
  hint?: string;
};

/** Parascene Creation support follows the refreshed server-6 capability snapshot. */
export const PARASCENE_BLUE_VIDEO_MODELS = parasceneProductVideoModelIds();

function isBlueVideoMethod(value: string): value is BlueVideoMethod {
  return (
    value === "text2video" ||
    value === "image2video" ||
    value === "audio2video" ||
    value === "video2video" ||
    value === "reference2video"
  );
}

function parseFromCapabilities(caps: BlueCapabilities): BlueVideoModelOption[] {
  const byId = new Map<string, BlueVideoModelOption>();

  const matrix = Array.isArray(caps.capability_matrix)
    ? caps.capability_matrix
    : [];
  for (const row of matrix as BlueCapabilityRow[]) {
    const method = typeof row.method === "string" ? row.method.trim() : "";
    const model = typeof row.model === "string" ? row.model.trim() : "";
    if (!isBlueVideoMethod(method) || !model) continue;
    const capsList = Array.isArray(row.capabilities)
      ? row.capabilities.map(String)
      : [];
    const flf =
      row.flf === true ||
      capsList.includes("flf") ||
      capsList.includes("style_transition");
    const nativeAudio = row.nativeAudio === true;
    byId.set(model, {
      id: model,
      label: model,
      method,
      flf,
      nativeAudio,
    });
  }

  const methods = caps.methods ?? {};
  for (const methodId of [
    "text2video",
    "image2video",
    "audio2video",
    "video2video",
    "reference2video",
  ] as const) {
    const def = methods[methodId];
    const options = def?.fields?.model?.options;
    if (!Array.isArray(options)) continue;
    for (const opt of options) {
      const id = typeof opt?.value === "string" ? opt.value.trim() : "";
      if (!id) continue;
      const label =
        typeof opt?.label === "string" && opt.label.trim()
          ? opt.label.trim()
          : id;
      const hint =
        typeof opt?.hint === "string" && opt.hint.trim()
          ? opt.hint.trim()
          : undefined;
      const existing = byId.get(id);
      if (existing) {
        byId.set(id, { ...existing, label, hint: hint ?? existing.hint });
      } else {
        byId.set(id, {
          id,
          label,
          method: methodId,
          flf: false,
          nativeAudio: false,
          hint,
        });
      }
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (a.method !== b.method) return a.method.localeCompare(b.method);
    return a.label.localeCompare(b.label);
  });
}

function productSnapshotVideoModels(): BlueVideoModelOption[] {
  return parasceneVideoModels()
    .filter(
      (model): model is typeof model & { method: BlueVideoMethod } =>
        model.serverId === 6 && isBlueVideoMethod(model.method),
    )
    .map((model) => ({
      id: model.id,
      label: model.label,
      method: model.method,
      flf: model.flf,
      nativeAudio: model.nativeAudio,
      hint: model.hint,
    }));
}

export async function loadBlueVideoModels(opts?: {
  blueDirect?: boolean;
}): Promise<BlueVideoModelOption[]> {
  if (opts?.blueDirect === false) return productSnapshotVideoModels();
  try {
    const caps = await blueCapabilities();
    const parsed = parseFromCapabilities(caps);
    if (parsed.length > 0) return parsed;
  } catch {
    /* offline / not configured — use snapshot */
  }
  return parseFromCapabilities(
    blueCapabilitiesSnapshot as unknown as BlueCapabilities,
  );
}

export function blueMethodForIntent(
  intentId: GenerateIntentId,
): BlueVideoMethod | null {
  switch (intentId) {
    case "text_to_video":
      return "text2video";
    case "image_to_video":
      return "image2video";
    case "image_audio_to_video":
      return "audio2video";
    case "video_to_video":
      return "video2video";
    case "reference_to_video":
      return "reference2video";
    default:
      return null;
  }
}

export function blueMethodForTimelineFill(opts: {
  continuity: AddAssetContinuityMode;
  audioMode: AddAssetAudioMode;
}): BlueVideoMethod {
  if (opts.continuity === "none") return "text2video";
  if (opts.continuity === "start_frame" && opts.audioMode !== "none") {
    return "audio2video";
  }
  return "image2video";
}

/** Expand legacy draft aliases (`wan` / `ltx`) to concrete Blue model ids. */
export function expandLegacyBlueModelId(
  selected: string | null | undefined,
  method: BlueVideoMethod,
): string | null {
  const raw = selected?.trim();
  if (!raw) return null;
  if (raw === "wan") {
    return method === "text2video" ? "wan_t2v" : "wan_i2v";
  }
  if (raw === "ltx") {
    if (method === "text2video") return "ltx_t2v";
    if (method === "audio2video") return "ltx_a2v";
    return "ltx_i2v";
  }
  return raw;
}

export function isWanFamilyBlueModel(modelId: string): boolean {
  const id = modelId.trim();
  return id === "wan" || id.startsWith("wan_");
}

export function filterBlueVideoModels(opts: {
  models: readonly BlueVideoModelOption[];
  method: BlueVideoMethod;
  continuity: AddAssetContinuityMode;
  /** When false, only models Parascene Creation can run. */
  blueDirect: boolean;
}): BlueVideoModelOption[] {
  let list = opts.models.filter((m) => m.method === opts.method);
  if (!opts.blueDirect) {
    list = list.filter((m) => PARASCENE_BLUE_VIDEO_MODELS.has(m.id));
  }
  if (opts.continuity === "first_last") {
    list = list.filter((m) => m.flf);
  } else if (opts.continuity === "start_frame" && opts.method === "image2video") {
    // Style transition is a first+last specialty.
    list = list.filter((m) => m.id !== "ltx_style_transition");
  }
  return list;
}

export function pickCompatibleBlueModel(opts: {
  models: readonly BlueVideoModelOption[];
  method: BlueVideoMethod;
  continuity: AddAssetContinuityMode;
  blueDirect: boolean;
  preferredId?: string | null;
}): BlueVideoModelOption | null {
  const compatible = filterBlueVideoModels(opts);
  if (compatible.length === 0) return null;
  const preferred = expandLegacyBlueModelId(opts.preferredId, opts.method);
  if (preferred) {
    const match = compatible.find((m) => m.id === preferred);
    if (match) return match;
  }
  const defaults: Record<BlueVideoMethod, string[]> = {
    text2video: ["ltx_t2v", "wan_t2v", "minimax_t2v"],
    image2video:
      opts.continuity === "first_last"
        ? ["wan_i2v", "minimax_i2v", "ltx_i2v"]
        : ["ltx_i2v", "wan_i2v", "minimax_i2v"],
    audio2video: ["ltx_a2v", "ltx_id_lora"],
    video2video: [DEFAULT_V2V_MODEL_ID, "wan_animate", "ltx_ic_lora", "wan_scail"],
    reference2video: [DEFAULT_R2V_MODEL_ID, "ltx_ingredients"],
  };
  for (const id of defaults[opts.method]) {
    const match = compatible.find((m) => m.id === id);
    if (match) return match;
  }
  return compatible[0] ?? null;
}

export function resolveBlueVideoModelId(opts: {
  selected: string | null | undefined;
  method: BlueVideoMethod;
  continuity: AddAssetContinuityMode;
  blueDirect: boolean;
  models?: readonly BlueVideoModelOption[] | null;
}): string {
  const picked = pickCompatibleBlueModel({
    models: opts.models?.length
      ? opts.models
      : parseFromCapabilities(
          blueCapabilitiesSnapshot as unknown as BlueCapabilities,
        ),
    method: opts.method,
    continuity: opts.continuity,
    blueDirect: opts.blueDirect,
    preferredId: opts.selected,
  });
  return (
    picked?.id ??
    expandLegacyBlueModelId(opts.selected, opts.method) ??
    (opts.method === "text2video"
      ? "ltx_t2v"
      : opts.method === "audio2video"
        ? "ltx_a2v"
        : opts.method === "video2video"
        ? DEFAULT_V2V_MODEL_ID
        : opts.method === "reference2video"
          ? DEFAULT_R2V_MODEL_ID
          : opts.continuity === "first_last"
            ? "wan_i2v"
            : "ltx_i2v")
  );
}
