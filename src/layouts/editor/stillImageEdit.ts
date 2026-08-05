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
import {
  importLocalPaths,
} from "../../library/catalogClient";
import { importLocalPathsForProject } from "../../project/boundFolderLanding";

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
    if (!/image|photo|picture|frame/.test(blob) || /mask/.test(blob)) return [];
    const array =
      field.arrayItemFileLike ||
      (field.typeName === "array" &&
        (/image|photo|picture/.test(blob) || field.format === "uri"));
    const scalar =
      field.fileLike ||
      field.format === "uri" ||
      ((field.typeName === "string" || field.typeName.includes("uri")) &&
        !field.enumValues?.length);
    return array || scalar ? [{ field, array }] : [];
  });
  for (const name of preferred) {
    const match = candidates.find((row) => row.field.name === name);
    if (match) return match;
  }
  return candidates[0] ?? null;
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
  boundFolderId: string | null | undefined;
  /**
   * When false (default), import into Library only — stays inside the
   * composition until the user promotes it into project Assets.
   */
  landInProject?: boolean;
  onProgress?: (note: string) => void;
};

export async function runStillImageEdit(opts: RunStillImageEditOpts): Promise<{
  creationId: string;
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

  opts.onProgress?.("Importing edit into library…");
  const landInProject = opts.landInProject === true;
  const imported = landInProject
    ? await importLocalPathsForProject({
        paths: [outputPath],
        boundFolderId: opts.boundFolderId,
      })
    : await importLocalPaths([outputPath]);
  const created = imported.creations[0];
  if (!created?.id) {
    throw new Error("Import produced no Library creation from still edit.");
  }

  // Keep schema detail referenced so unused warnings stay quiet if we expand later.
  void detail.owner;

  return {
    creationId: created.id,
    modelId,
    predictionId: result.predictionId?.trim() || predictionId,
  };
}
