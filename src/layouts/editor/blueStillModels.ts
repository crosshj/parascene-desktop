/**
 * Blue text2image / image2image model options from live capabilities
 * (snapshot fallback when Blue is offline).
 */

import {
  blueCapabilities,
  type BlueCapabilities,
} from "../../blue/blueClient";

export type BlueStillMethod = "text2image" | "image2image";

export type BlueStillModelOption = {
  id: string;
  label: string;
  hint?: string;
};

/** Sensible defaults from the checked-in capabilities snapshot. */
const TEXT2IMAGE_SNAPSHOT: BlueStillModelOption[] = [
  {
    id: "diffusion_models/flux/flux1-dev.safetensors",
    label: "flux: flux1-dev",
  },
  {
    id: "checkpoints/FLUX1/flux1-dev-fp8.safetensors",
    label: "flux: flux1-dev-fp8",
  },
  {
    id: "diffusion_models/flux/flux1-schnell.safetensors",
    label: "flux: flux1-schnell",
  },
  {
    id: "diffusion_models/flux/flux1-krea-dev_fp8_scaled.safetensors",
    label: "flux: flux1-krea-dev_fp8_scaled",
  },
];

function parseStillModels(
  caps: BlueCapabilities,
  method: BlueStillMethod,
): BlueStillModelOption[] {
  const options = caps.methods?.[method]?.fields?.model?.options;
  if (!Array.isArray(options) || options.length === 0) return [];
  const out: BlueStillModelOption[] = [];
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
    out.push({ id, label, hint });
  }
  return out;
}

export async function loadBlueStillModels(
  method: BlueStillMethod = "text2image",
): Promise<BlueStillModelOption[]> {
  try {
    const caps = await blueCapabilities();
    const parsed = parseStillModels(caps, method);
    if (parsed.length > 0) return parsed;
  } catch {
    /* offline / not configured */
  }
  return method === "text2image" ? TEXT2IMAGE_SNAPSHOT : [];
}

export function pickBlueStillModel(
  models: readonly BlueStillModelOption[],
  preferredId?: string | null,
): BlueStillModelOption | null {
  if (models.length === 0) return null;
  const preferred = preferredId?.trim();
  if (preferred) {
    const match = models.find((m) => m.id === preferred);
    if (match) return match;
  }
  const fluxDev = models.find((m) => m.id.includes("flux1-dev.safetensors"));
  return fluxDev ?? models[0] ?? null;
}
