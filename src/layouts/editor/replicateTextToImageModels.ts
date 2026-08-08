/**
 * Load enabled Replicate models suitable for editor text → image (Assets).
 */

import {
  replicateModelGet,
  replicateModelsListEnabled,
  type ReplicateInputField,
  type ReplicateModelDetail,
} from "../../replicate/replicateClient";
import {
  modelProducesImageOutput,
  pickImageInputField,
  pickPromptField,
} from "./stillImageEdit";

export type ReplicateTextToImageModelOption = {
  id: string;
  owner: string;
  name: string;
  label: string;
  description: string;
  inputs: ReplicateInputField[];
  promptField: string;
  aspectRatioField: string | null;
};

function parseOwnerName(id: string): { owner: string; name: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  return { owner: id.slice(0, slash), name: id.slice(slash + 1) };
}

function isAspectRatioField(field: ReplicateInputField): boolean {
  const n = field.name.toLowerCase().replace(/-/g, "_");
  return n === "aspect_ratio" || n === "aspectratio";
}

function isRequiredVideoOrAudioInput(field: ReplicateInputField): boolean {
  if (!field.required) return false;
  const blob = `${field.name} ${field.title ?? ""} ${field.description ?? ""}`.toLowerCase();
  if (/mask|prompt|caption|description|negative/.test(field.name.toLowerCase())) {
    return false;
  }
  const mediaHint = /\b(?:video|audio|music|speech|sound)\b/.test(blob);
  if (!mediaHint) return false;
  return (
    field.fileLike ||
    field.arrayItemFileLike ||
    field.format === "uri" ||
    field.typeName.includes("uri") ||
    (field.typeName === "array" && mediaHint)
  );
}

/** True when an enabled model's schema supports prompt-only still generation. */
export function modelSupportsTextToImage(
  detail: Pick<
    ReplicateModelDetail,
    "raw" | "name" | "description" | "features" | "inputs" | "schemaCached"
  >,
): boolean {
  if (!detail.schemaCached || !detail.inputs?.length) return false;
  if (!modelProducesImageOutput(detail)) return false;
  const prompt = pickPromptField(detail.inputs);
  if (!prompt) return false;

  const imageInput = pickImageInputField(detail.inputs);
  if (imageInput?.field.required) return false;

  if (detail.inputs.some(isRequiredVideoOrAudioInput)) return false;

  return true;
}

/** Fetch enabled models that can generate a still from a text prompt. */
export async function loadReplicateTextToImageModels(): Promise<
  ReplicateTextToImageModelOption[]
> {
  const enabled = await replicateModelsListEnabled();
  const options: ReplicateTextToImageModelOption[] = [];
  for (const id of enabled) {
    const parsed = parseOwnerName(id);
    if (!parsed) continue;
    let detail: ReplicateModelDetail | null;
    try {
      detail = await replicateModelGet(parsed.owner, parsed.name);
    } catch {
      continue;
    }
    if (!detail || !modelSupportsTextToImage(detail)) continue;
    const prompt = pickPromptField(detail.inputs);
    if (!prompt) continue;
    const aspect = detail.inputs.find(isAspectRatioField) ?? null;
    options.push({
      id,
      owner: parsed.owner,
      name: parsed.name,
      label: id,
      description: (detail.description ?? "").trim(),
      inputs: detail.inputs,
      promptField: prompt.name,
      aspectRatioField: aspect?.name ?? null,
    });
  }
  options.sort((a, b) => a.id.localeCompare(b.id));
  return options;
}
