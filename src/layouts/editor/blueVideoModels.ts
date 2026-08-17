/**
 * Blue video models for timeline fill — live GET /api capabilities with a
 * checked-in snapshot fallback (same surface as Lab / Blue Methods).
 */

import {
  blueCapabilities,
  type BlueCapabilities,
  type BlueCapabilityRow,
} from "../../blue/blueClient";
import type { AddAssetAudioMode, AddAssetContinuityMode } from "./addAssetGenerate";

export type BlueVideoMethod = "text2video" | "image2video" | "audio2video";

export type BlueVideoModelOption = {
  id: string;
  label: string;
  method: BlueVideoMethod;
  flf: boolean;
  nativeAudio: boolean;
  hint?: string;
};

/** Parascene Creation path only runs these method models today. */
export const PARASCENE_BLUE_VIDEO_MODELS = new Set([
  "wan_t2v",
  "ltx_t2v",
  "wan_i2v",
  "ltx_i2v",
  "ltx_a2v",
]);

const SNAPSHOT: BlueVideoModelOption[] = [
  {
    id: "wan_t2v",
    label: "Wan — text-to-video (rapid AIO)",
    method: "text2video",
    flf: false,
    nativeAudio: false,
  },
  {
    id: "ltx_t2v",
    label: "LTX — text-to-video",
    method: "text2video",
    flf: false,
    nativeAudio: true,
  },
  {
    id: "minimax_t2v",
    label: "MiniMax H3 — text-to-video (FL2VA)",
    method: "text2video",
    flf: false,
    nativeAudio: true,
  },
  {
    id: "wan_i2v",
    label: "Wan — image-to-video",
    method: "image2video",
    flf: true,
    nativeAudio: false,
  },
  {
    id: "ltx_i2v",
    label: "LTX — image-to-video",
    method: "image2video",
    flf: true,
    nativeAudio: true,
  },
  {
    id: "minimax_i2v",
    label: "MiniMax H3 — image-to-video (FL2VA)",
    method: "image2video",
    flf: true,
    nativeAudio: true,
  },
  {
    id: "ltx_style_transition",
    label: "LTX — style transition (flf + LoRA)",
    method: "image2video",
    flf: true,
    nativeAudio: true,
  },
  {
    id: "ltx_a2v",
    label: "LTX — audio-to-video (ia2v)",
    method: "audio2video",
    flf: false,
    nativeAudio: true,
  },
  {
    id: "ltx_id_lora",
    label: "LTX — ID-LoRA talkvid",
    method: "audio2video",
    flf: false,
    nativeAudio: true,
  },
];

function isBlueVideoMethod(value: string): value is BlueVideoMethod {
  return (
    value === "text2video" ||
    value === "image2video" ||
    value === "audio2video"
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
  for (const methodId of ["text2video", "image2video", "audio2video"] as const) {
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

export async function loadBlueVideoModels(): Promise<BlueVideoModelOption[]> {
  try {
    const caps = await blueCapabilities();
    const parsed = parseFromCapabilities(caps);
    if (parsed.length > 0) return parsed;
  } catch {
    /* offline / not configured — use snapshot */
  }
  return SNAPSHOT;
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
    models: opts.models?.length ? opts.models : SNAPSHOT,
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
        : opts.continuity === "first_last"
          ? "wan_i2v"
          : "ltx_i2v")
  );
}
