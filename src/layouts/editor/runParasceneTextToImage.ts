/**
 * Parascene credits path — Text to Image via server 6 Blue or server 1 Replicate lanes.
 */

import { createAuthedSdk } from "../../auth/session";
import { formatParasceneCreationFailure } from "../../sdk/parascene";
import { ingestRemoteCreation, newCreationToken } from "../../lab/ingestCreation";
import { fileCreationIntoProjectGroup } from "../../lab/projectGroups";
import {
  parasceneResolveStillModel,
  type ParasceneStillModelOption,
} from "./parasceneProductCaps";

export async function runParasceneTextToImage(opts: {
  prompt: string;
  aspectRatio: string;
  modelId: string;
  route?: ParasceneStillModelOption;
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  onProgress?: (note: string) => void;
  /** Called as soon as Parascene returns a creation id (before wait/import). */
  onCreationStarted?: (creationId: string) => void | Promise<void>;
}): Promise<{
  creationId: string;
  projectCreationIds: string[];
  imagesGroupId: string | null;
}> {
  const prompt = opts.prompt.trim();
  if (!prompt) throw new Error("Enter a prompt for text-to-image.");
  const route =
    opts.route ?? parasceneResolveStillModel("text_to_image", opts.modelId);
  if (!route) throw new Error("Choose a Parascene image model.");

  const label =
    route.family === "blue"
      ? "Parascene Blue"
      : route.family === "replicate_pro"
        ? "Replicate Pro"
        : route.family === "pixellab"
          ? "PixelLab"
          : "Replicate";

  opts.onProgress?.(`Starting image generation on ${label}…`);
  const sdk = createAuthedSdk();
  const args: Record<string, unknown> = {
    prompt,
    model: route.value,
  };
  if (route.method !== "pixelLabImage") {
    args.aspect_ratio = opts.aspectRatio;
  }

  const started = await sdk.create({
    serverId: route.serverId,
    method: route.method,
    creationToken: newCreationToken(),
    args,
  });
  await opts.onCreationStarted?.(String(started.id));
  opts.onProgress?.(`Waiting for ${started.id}…`);
  const done = await sdk.waitForCreation(started.id, {
    onTick: (row) =>
      opts.onProgress?.(`Waiting for ${started.id} (${row.status || "…"})`),
  });
  if (String(done.status).toLowerCase() === "failed") {
    throw new Error(formatParasceneCreationFailure(done, "Image generation"));
  }
  opts.onProgress?.("Syncing to Library…");
  const creationId = await ingestRemoteCreation(done);
  opts.onProgress?.("Filing into Images group…");
  const filed = await fileCreationIntoProjectGroup({
    creationId,
    mediaType: "image",
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
  });
  return {
    creationId,
    projectCreationIds: filed.projectCreationIds,
    imagesGroupId: filed.groupId ?? opts.imagesGroupId,
  };
}
