/**
 * Replicate-backed text → image generation into project Assets.
 */

import {
  listenReplicateRunProgress,
  replicateModelRun,
} from "../../replicate/replicateClient";
import { importLocalPathsForProject } from "../../project/projectAssetLanding";
import type { ProjectAspectRatio } from "../../project/aspectRatios";
import {
  aspectChooserOptionsFromSupported,
  pickAspectChooserValue,
} from "../../project/aspectRatios";
import type { ReplicateTextToImageModelOption } from "./replicateTextToImageModels";

export type RunReplicateTextToImageOpts = {
  model: ReplicateTextToImageModelOption;
  prompt: string;
  projectId: string;
  aspectRatio: ProjectAspectRatio;
  onProgress?: (note: string) => void;
};

export type RunReplicateTextToImageResult = {
  creationId: string;
  modelId: string;
  predictionId: string | null;
  localPath: string;
};

export async function runReplicateTextToImage(
  opts: RunReplicateTextToImageOpts,
): Promise<RunReplicateTextToImageResult> {
  const prompt = opts.prompt.trim();
  if (!prompt) {
    throw new Error("Enter a prompt to generate an image.");
  }

  const modelId = opts.model.id;
  const input: Record<string, unknown> = {
    [opts.model.promptField]: prompt,
  };

  if (opts.model.aspectRatioField) {
    const field = opts.model.inputs.find(
      (row) => row.name === opts.model.aspectRatioField,
    );
    const options = aspectChooserOptionsFromSupported(field?.enumValues);
    if (options.length > 0) {
      input[opts.model.aspectRatioField] = pickAspectChooserValue(
        options,
        opts.aspectRatio,
      );
    } else {
      input[opts.model.aspectRatioField] = opts.aspectRatio;
    }
  }

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
      opts.model.owner,
      opts.model.name,
      input,
      {},
      [],
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
    throw new Error("Replicate finished with no local output file.");
  }

  opts.onProgress?.("Importing image into Assets…");
  const imported = await importLocalPathsForProject({
    paths: [outputPath],
    projectId: opts.projectId,
  });
  const created = imported.creations[0];
  if (!created?.id) {
    throw new Error(
      "Import produced no Library creation. The Replicate run succeeded but the output could not be imported locally.",
    );
  }

  return {
    creationId: created.id,
    modelId,
    predictionId: result.predictionId?.trim() || predictionId,
    localPath: outputPath,
  };
}
