/**
 * Parascene credits path — Image to Image via server 6 Blue or server 1 Replicate lanes.
 */

import { getCreations } from "../../library/catalogClient";
import { runLabParasceneGenerate } from "../../services/labParasceneGenerate";
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
  const args: Record<string, unknown> = {
    prompt,
    model: route.value,
    input_images: [imageUrl],
  };
  if (route.method !== "pixelLabImage") {
    args.aspect_ratio = opts.aspectRatio;
  }

  const result = await runLabParasceneGenerate({
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
    serverId: route.serverId,
    method: route.method,
    args,
    mediaType: "image",
    intent: "image_to_image",
    label: route.label || route.method,
    onProgress: opts.onProgress,
  });
  return {
    creationId: result.creationId,
    projectCreationIds: result.projectCreationIds,
    imagesGroupId: result.imagesGroupId ?? opts.imagesGroupId,
  };
}
