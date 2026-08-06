/**
 * Direct Replicate image-to-image edit for still workstreams.
 */

import {
  listenReplicateRunProgress,
  replicateModelGet,
  replicateModelRun,
  type ReplicateInputField,
  type ReplicateModelDetail,
} from "../../replicate/replicateClient";
import { cacheCompositionRun } from "../../library/catalogClient";

export function pickImageInputField(
  inputs: readonly ReplicateInputField[],
): { field: ReplicateInputField; array: boolean } | null {
  const preferred = [
    "image",
    "input_image",
    "image_input",
    "input_images",
    "images",
    "reference_image",
    "reference_images",
    "input",
    "init_image",
    "start_image",
    "img",
  ];
  const candidates = inputs.flatMap((field) => {
    const blob = `${field.name} ${field.title ?? ""} ${field.description ?? ""}`.toLowerCase();
    if (
      /prompt|caption|description|negative/.test(field.name.toLowerCase()) ||
      !/image|photo|picture|frame/.test(blob) ||
      /mask/.test(blob)
    ) {
      return [];
    }
    const array =
      field.arrayItemFileLike ||
      (field.typeName === "array" &&
        (/image|photo|picture/.test(blob) || field.format === "uri"));
    const scalar =
      field.fileLike ||
      field.format === "uri" ||
      field.typeName.includes("uri");
    return array || scalar ? [{ field, array }] : [];
  });
  for (const name of preferred) {
    const match = candidates.find((row) => row.field.name === name);
    if (match) return match;
  }
  return candidates[0] ?? null;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function collectStrings(value: unknown, result: string[] = []): string[] {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result);
  } else {
    const object = asObject(value);
    if (object) {
      for (const item of Object.values(object)) collectStrings(item, result);
    }
  }
  return result;
}

function outputSchema(raw: unknown): unknown {
  const root = asObject(raw);
  const latest = asObject(root?.latest_version);
  const openApi = asObject(latest?.openapi_schema);
  const components = asObject(openApi?.components);
  const schemas = asObject(components?.schemas);
  return schemas?.Output;
}

/** True only when the model's Replicate metadata indicates a still-image output. */
export function modelProducesImageOutput(
  detail: Pick<
    ReplicateModelDetail,
    "raw" | "name" | "description" | "features"
  >,
): boolean {
  const raw = asObject(detail.raw);
  const example = asObject(raw?.default_example);
  const exampleOutput = collectStrings(example?.output);
  const imageFile = /\.(?:avif|bmp|gif|heic|jpe?g|png|tiff?|webp)(?:[?#]|$)/i;
  const otherMediaFile =
    /\.(?:aac|avi|flac|m4a|m4v|mkv|mov|mp3|mp4|mpeg|ogg|wav|webm)(?:[?#]|$)/i;
  if (exampleOutput.some((value) => imageFile.test(value))) return true;
  if (exampleOutput.some((value) => otherMediaFile.test(value))) return false;

  const schema = outputSchema(detail.raw);
  const schemaText = collectStrings(schema).join(" ").toLowerCase();
  if (/image\/(?:avif|bmp|gif|jpeg|png|tiff|webp)|\b(?:image|picture|photo)\b/.test(schemaText)) {
    return true;
  }
  if (/video\/|audio\/|\b(?:video|audio|music|speech)\b/.test(schemaText)) {
    return false;
  }

  // Replicate commonly describes all downloadable outputs as an untyped URI.
  // In that case require an image-oriented model and reject other image-input
  // tasks (video generation, captioning, detection, embeddings, and so on).
  const schemaObject = asObject(schema);
  const items = asObject(schemaObject?.items);
  const uriOutput =
    schemaObject?.format === "uri" ||
    items?.format === "uri" ||
    schemaText.includes("uri");
  if (!uriOutput) return false;

  const metadata = `${detail.name} ${detail.description ?? ""} ${detail.features.join(" ")}`.toLowerCase();
  if (
    /\b(?:video|audio|music|speech|caption|ocr|detect(?:ion|or)?|classif(?:y|ier|ication)|embedding|segment(?:ation)?|depth|pose|recognition|vision.language)\b/.test(
      metadata,
    )
  ) {
    return false;
  }
  return /\bimage\b|image_(?:in|out)|photo|picture|inpaint|upscal/.test(metadata);
}

function pickPromptField(
  inputs: readonly ReplicateInputField[],
): ReplicateInputField | null {
  return (
    inputs.find((row) => row.name === "prompt") ??
    inputs.find((row) => /prompt/i.test(row.name)) ??
    null
  );
}

export async function loadReplicateImageEditModel(
  owner: string,
  name: string,
): Promise<{
  detail: ReplicateModelDetail;
  imageField: ReplicateInputField;
  imageFieldIsArray: boolean;
  promptField: ReplicateInputField | null;
}> {
  const detail = await replicateModelGet(owner, name);
  if (!detail) {
    throw new Error(`Replicate model ${owner}/${name} not found in local cache.`);
  }
  const imageInput = pickImageInputField(detail.inputs);
  if (!imageInput) {
    throw new Error(
      `${owner}/${name} has no image input field suitable for still edits.`,
    );
  }
  return {
    detail,
    imageField: imageInput.field,
    imageFieldIsArray: imageInput.array,
    promptField: pickPromptField(detail.inputs),
  };
}

export type RunStillImageEditOpts = {
  owner: string;
  name: string;
  prompt: string;
  sourceLocalPath: string;
  compositionId: string;
  onProgress?: (note: string) => void;
};

export async function runStillImageEdit(opts: RunStillImageEditOpts): Promise<{
  creationId: null;
  localPath: string;
  modelId: string;
  predictionId: string | null;
}> {
  const modelId = `${opts.owner}/${opts.name}`;
  const { detail, imageField, imageFieldIsArray, promptField } =
    await loadReplicateImageEditModel(opts.owner, opts.name);
  const input: Record<string, unknown> = {};
  if (promptField) {
    input[promptField.name] = opts.prompt.trim();
  }
  const localFiles: Record<string, string | string[]> = {
    [imageField.name]: imageFieldIsArray
      ? [opts.sourceLocalPath]
      : opts.sourceLocalPath,
  };

  opts.onProgress?.(`Running ${modelId}…`);
  let predictionId: string | null = null;
  const unlisten = await listenReplicateRunProgress((ev) => {
    if (ev.predictionId?.trim()) predictionId = ev.predictionId.trim();
    if (ev.message?.trim()) opts.onProgress?.(ev.message.trim());
    else if (ev.status) opts.onProgress?.(`${modelId}: ${ev.status}`);
  });

  let result;
  try {
    result = await replicateModelRun(
      opts.owner,
      opts.name,
      input,
      localFiles,
      [imageField.name],
    );
  } finally {
    unlisten();
  }

  if (result.error || result.status === "failed" || result.status === "canceled") {
    throw new Error(
      result.error?.trim() || `Replicate run ${result.status || "failed"}`,
    );
  }
  const outputPath = result.localPaths.find((p) => p.trim())?.trim();
  if (!outputPath) {
    throw new Error("Replicate still edit finished with no local output file.");
  }

  opts.onProgress?.("Saving edit in composition cache…");
  const cachedPath = await cacheCompositionRun(outputPath, opts.compositionId);

  // Keep schema detail referenced so unused warnings stay quiet if we expand later.
  void detail.owner;

  return {
    creationId: null,
    localPath: cachedPath,
    modelId,
    predictionId: result.predictionId?.trim() || predictionId,
  };
}
