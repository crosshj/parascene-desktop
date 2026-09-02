import { describe, expect, it } from "vitest";
import { planAdvancedVideoSend, REPLICATE_H3_INPUT_NAMES } from "./generateAdvancedVideoSend";
import {
  normalizeGenerateMediaRefs,
  TIMELINE_IMAGE_PREVIOUS,
} from "./generateMediaRefs";
import type { ReplicateInputField } from "../../replicate/replicateClient";
import {
  modelSupportsAnyVideoFill,
} from "./replicateVideoModels";
import {
  replicateHasReferencePackage,
  replicateVideoCapability,
} from "./replicateRunConstraints";

describe("planAdvancedVideoSend", () => {
  it("sends Parascene v2v as Creation URL slots", () => {
    const plan = planAdvancedVideoSend({
      intentId: "video_to_video",
      lane: "parascene",
      prompt: "restyle the shot",
      model: "bernini_r_v2v",
      aspectRatio: "16:9",
      durationSec: 5,
      refs: normalizeGenerateMediaRefs({
        inputVideoAssetId: "vid-1",
        startOffsetSeconds: 1.5,
      }),
    });
    expect(plan.method).toBe("video2video");
    expect(plan.transport).toBe("creation_urls");
    expect(plan.mediaFields.videos).toBe("input_video_urls");
    expect(plan.slotIds.videos).toEqual(["vid-1"]);
    expect(plan.args).toMatchObject({
      prompt: "restyle the shot",
      model: "bernini_r_v2v",
      duration_seconds: 5,
      start_offset_seconds: 1.5,
    });
    expect(plan.args).not.toHaveProperty("input_video_urls");
  });

  it("sends Blue-direct r2v as local-file slots", () => {
    const plan = planAdvancedVideoSend({
      intentId: "reference_to_video",
      lane: "blue_direct",
      prompt: "<Picture 1> walks",
      model: "minimax_r2v",
      aspectRatio: "16:9",
      durationSec: 8,
      refs: normalizeGenerateMediaRefs({
        referenceImageAssetIds: [
          TIMELINE_IMAGE_PREVIOUS,
          "img-1",
          "img-2",
        ],
        referenceVideoAssetIds: ["vid-2"],
        referenceAudioAssetIds: ["aud-1"],
      }),
    });
    expect(plan.method).toBe("reference2video");
    expect(plan.transport).toBe("local_files");
    expect(plan.mediaFields).toEqual({
      images: "input_images",
      videos: "input_video_urls",
      audios: "input_audio_urls",
    });
    expect(plan.slotIds.images).toEqual([
      TIMELINE_IMAGE_PREVIOUS,
      "img-1",
      "img-2",
    ]);
    expect(plan.slotIds.videos).toEqual(["vid-2"]);
    expect(plan.slotIds.audios).toEqual(["aud-1"]);
  });

  it("maps Replicate H3 refs but leaves the lane unwired", () => {
    const plan = planAdvancedVideoSend({
      intentId: "reference_to_video",
      lane: "replicate",
      prompt: "same character",
      model: "minimax/h3",
      aspectRatio: "16:9",
      refs: normalizeGenerateMediaRefs({
        referenceImageAssetIds: ["img-1"],
      }),
    });
    expect(plan.transport).toBe("unwired");
    expect(plan.mediaFields.images).toBe("reference_image_urls");
    expect(REPLICATE_H3_INPUT_NAMES).toContain("reference_image_urls");
    expect(REPLICATE_H3_INPUT_NAMES).toContain("first_frame_image");
  });
});

describe("Replicate H3 OpenAPI vs video-fill heuristics", () => {
  function field(name: string): ReplicateInputField {
    return {
      name,
      title: null,
      typeName: "string",
      required: false,
      description: null,
      format: null,
      defaultValue: null,
      enumValues: null,
      minimum: null,
      maximum: null,
      fileLike: name.includes("frame"),
      arrayItemFileLike: name.endsWith("_urls"),
    };
  }

  const h3Inputs = REPLICATE_H3_INPUT_NAMES.map((name) => field(name));

  it("detects the omni-ref package but not timeline-fill continuity", () => {
    expect(replicateHasReferencePackage(h3Inputs)).toBe(true);
    expect(modelSupportsAnyVideoFill(h3Inputs)).toBe(false);
    expect(replicateVideoCapability(h3Inputs)).toEqual({
      startOnly: false,
      startEnd: false,
      motionControl: false,
    });
  });
});
