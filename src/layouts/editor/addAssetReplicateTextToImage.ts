/**
 * Replicate-backed text → image generation into project Assets.
 */

import { listenReplicateRunProgress } from "../../replicate/replicateClient";
import {
  invokeReplicateGenerateStill,
  watchLocalGenerateStill,
} from "../../services/generateStill";
import type { ProjectAspectRatio } from "../../project/aspectRatios";
import type { ReplicateTextToImageModelOption } from "./replicateTextToImageModels";
import { buildReplicateTextToImageInput } from "./textToImageInput";

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

/** Direct invoke + watch (Lab-style). Prefer {@link startLibraryReplicateTextToImage} in Editor. */
export async function runReplicateTextToImage(
  opts: RunReplicateTextToImageOpts,
): Promise<RunReplicateTextToImageResult> {
  const prompt = opts.prompt.trim();
  if (!prompt) {
    throw new Error("Enter a prompt to generate an image.");
  }

  const modelId = opts.model.id;
  const input = buildReplicateTextToImageInput({
    model: opts.model,
    prompt,
    aspectRatio: opts.aspectRatio,
  });

  opts.onProgress?.(`Running ${modelId}…`);
  let predictionId: string | null = null;
  const unlisten = await listenReplicateRunProgress((ev) => {
    if (ev.predictionId?.trim()) predictionId = ev.predictionId.trim();
    if (ev.message?.trim()) opts.onProgress?.(ev.message.trim());
    else if (ev.status) opts.onProgress?.(`${modelId}: ${ev.status}`);
  });

  try {
    const handle = await invokeReplicateGenerateStill({
      owner: opts.model.owner,
      name: opts.model.name,
      input,
      localFiles: {},
      requiredFileFields: [],
      projectId: opts.projectId,
      target: "assets",
      label: modelId,
    });
    const result = await watchLocalGenerateStill(handle, {
      onUpdate: (run) => {
        const note = run.progressNote?.trim();
        if (note) opts.onProgress?.(note);
      },
    });
    const localPath = result.localPaths[0]?.trim() ?? "";
    return {
      creationId: result.creationId,
      modelId,
      predictionId: result.predictionId?.trim() || predictionId,
      localPath,
    };
  } finally {
    unlisten();
  }
}
