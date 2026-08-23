/**
 * Parascene credits path — Image to Image via server 6 Blue or server 1 Replicate lanes.
 */

import { createAuthedSdk } from "../../auth/session";
import { formatParasceneCreationFailure } from "../../sdk/parascene";
import { getCreations } from "../../library/catalogClient";
import { ingestRemoteCreation, newCreationToken } from "../../lab/ingestCreation";
import { fileCreationIntoProjectGroup } from "../../lab/projectGroups";
import { parasceneImageUrlFromCreation } from "./addAssetStartFrame";
import {
  parasceneResolveStillModel,
  type ParasceneStillModelOption,
} from "./parasceneProductCaps";

export async function runParasceneImageToImage(opts: {
  prompt: string;
  aspectRatio: string;
  modelId: string;
  route?: ParasceneStillModelOption;
  sourceCreationId: string;
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  onProgress?: (note: string) => void;
}): Promise<{
  creationId: string;
  projectCreationIds: string[];
  imagesGroupId: string | null;
}> {
  const prompt = opts.prompt.trim();
  if (!prompt) throw new Error("Enter a prompt for image-to-image.");
  const route =
    opts.route ?? parasceneResolveStillModel("image_to_image", opts.modelId);
  if (!route) throw new Error("Choose a Parascene image model.");
  const sourceId = opts.sourceCreationId.trim();
  if (!sourceId) throw new Error("Choose a source image from Assets.");

  const [source] = await getCreations([sourceId]);
  if (!source) throw new Error("Source image not found in Library.");
  const imageUrl = parasceneImageUrlFromCreation(source);
  if (!imageUrl) {
    throw new Error(
      "Source image has no public Parascene URL — sync it from Parascene first.",
    );
  }
  if (/^asset:\/\//i.test(imageUrl) || /localhost|127\.0\.0\.1/i.test(imageUrl)) {
    throw new Error(
      "Source image is only available locally — sync it from Parascene before using it for generation.",
    );
  }

  const label =
    route.family === "blue"
      ? "Parascene Blue"
      : route.family === "replicate_pro"
        ? "Replicate Pro"
        : "Replicate";

  opts.onProgress?.(`Starting image-to-image on ${label}…`);
  const sdk = createAuthedSdk();
  const args: Record<string, unknown> = {
    prompt,
    model: route.value,
    input_images: [imageUrl],
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
  opts.onProgress?.(`Waiting for ${started.id}…`);
  const done = await sdk.waitForCreation(started.id, {
    onTick: (row) =>
      opts.onProgress?.(`Waiting for ${started.id} (${row.status || "…"})`),
  });
  if (String(done.status).toLowerCase() === "failed") {
    throw new Error(formatParasceneCreationFailure(done, "Image-to-image"));
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
