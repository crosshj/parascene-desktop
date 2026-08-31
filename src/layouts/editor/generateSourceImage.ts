/**
 * How Generate treats a project source image.
 * Spec: docs/GUIDE-generate-source-images.md
 */

export type GenerateSourceTarget = "parascene_blue" | "blue_direct" | "replicate";

export type GenerateSourceImageFacts = {
  target: GenerateSourceTarget;
  /** Still is already a Parascene image Creation with a public URL. */
  hostedStill: boolean;
  /** That Creation is the Images cover or a group member. */
  inImagesGroup: boolean;
  /** Frame extracted from a project video, not picked as an image. */
  videoStill: boolean;
  /** Pixels differ from the hosted original (fill/stretch). Video stills are always derived. */
  derivedPixels: boolean;
};

export type GenerateSourceSend =
  | "parascene_url"
  | "upload_new_creation"
  | "upload_ephemeral"
  | "local_file";

export type GenerateSourceDurableId =
  | "source_asset"
  | "new_creation"
  | "ephemeral_url"
  | "local_extract";

export type GenerateSourceImagePlan = {
  send: GenerateSourceSend;
  /** Append a newly uploaded still. Never the source id. */
  fileNewStillIntoImages: boolean;
  durableId: GenerateSourceDurableId;
  /** Always false — regrouping a cabinet member is never a Generate action. */
  regroupSource: false;
};

export function planGenerateSourceImage(
  facts: GenerateSourceImageFacts,
): GenerateSourceImagePlan {
  const regroupSource = false as const;
  // inImagesGroup does not change send. Grouped vs not is asked so regroup
  // cannot be treated as a Generate action later.

  if (facts.target !== "parascene_blue") {
    return {
      send: "local_file",
      fileNewStillIntoImages: false,
      durableId:
        facts.videoStill || facts.derivedPixels ? "local_extract" : "source_asset",
      regroupSource,
    };
  }

  if (facts.videoStill) {
    return {
      send: "upload_ephemeral",
      fileNewStillIntoImages: false,
      durableId: "ephemeral_url",
      regroupSource,
    };
  }
  const mustNewStill = !facts.hostedStill || facts.derivedPixels;
  if (mustNewStill) {
    return {
      send: "upload_new_creation",
      fileNewStillIntoImages: true,
      durableId: "new_creation",
      regroupSource,
    };
  }

  return {
    send: "parascene_url",
    fileNewStillIntoImages: false,
    durableId: "source_asset",
    regroupSource,
  };
}

export function generateSourceFactsFromFrame(opts: {
  target: GenerateSourceTarget;
  sourceIsImage: boolean;
  sourceAssetId: string | null | undefined;
  parasceneImageUrl: string | null | undefined;
  framing: string | null | undefined;
  imagesGroupId: string | null | undefined;
  imagesGroupMemberIds?: readonly string[];
}): GenerateSourceImageFacts {
  const sourceId = opts.sourceAssetId?.trim() || "";
  const groupId = opts.imagesGroupId?.trim() || "";
  const inImagesGroup = Boolean(
    sourceId &&
      (sourceId === groupId ||
        (opts.imagesGroupMemberIds ?? []).some(
          (id) => String(id).trim() === sourceId,
        )),
  );
  const videoStill = !opts.sourceIsImage;
  const hostedStill = !videoStill && Boolean(opts.parasceneImageUrl?.trim());
  const framing = (opts.framing ?? "fit").trim() || "fit";
  const derivedPixels = videoStill || framing !== "fit";
  return {
    target: opts.target,
    hostedStill,
    inImagesGroup,
    videoStill,
    derivedPixels,
  };
}
