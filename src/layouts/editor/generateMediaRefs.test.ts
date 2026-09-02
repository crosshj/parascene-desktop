import { describe, expect, it } from "vitest";
import {
  DEFAULT_R2V_MODEL_ID,
  H3_R2V_MODEL_ID,
  isTimelineImageRefId,
  normalizeGenerateMediaRefs,
  previousTimelineVideoAssetId,
  referencePromptTagHint,
  TIMELINE_IMAGE_NEXT,
  TIMELINE_IMAGE_PREVIOUS,
  timelineImageRefLabel,
  validateGenerateMediaRefs,
  v2vModelNeedsCharacter,
} from "./generateMediaRefs";
import type { TimelineClip } from "../../project/types";

describe("generateMediaRefs", () => {
  it("defaults MiniMax H3 for refs-to-video", () => {
    expect(DEFAULT_R2V_MODEL_ID).toBe(H3_R2V_MODEL_ID);
    expect(H3_R2V_MODEL_ID).toBe("minimax_r2v");
  });

  it("requires a driving video for v2v", () => {
    expect(
      validateGenerateMediaRefs({
        intentId: "video_to_video",
        refs: normalizeGenerateMediaRefs({}),
      }),
    ).toMatch(/source video/i);
    expect(
      validateGenerateMediaRefs({
        intentId: "video_to_video",
        refs: normalizeGenerateMediaRefs({ inputVideoAssetId: "vid-1" }),
        modelId: "bernini_r_v2v",
      }),
    ).toBeNull();
  });

  it("requires a character still for wan_animate", () => {
    expect(v2vModelNeedsCharacter("wan_animate")).toBe(true);
    expect(
      validateGenerateMediaRefs({
        intentId: "video_to_video",
        refs: normalizeGenerateMediaRefs({ inputVideoAssetId: "vid-1" }),
        modelId: "wan_animate",
      }),
    ).toMatch(/character/i);
  });

  it("requires image or video for r2v; audio alone is not enough", () => {
    expect(
      validateGenerateMediaRefs({
        intentId: "reference_to_video",
        refs: normalizeGenerateMediaRefs({
          referenceAudioAssetIds: ["a1"],
        }),
      }),
    ).toMatch(/image or video/i);
    expect(
      validateGenerateMediaRefs({
        intentId: "reference_to_video",
        refs: normalizeGenerateMediaRefs({
          referenceImageAssetIds: ["img-1"],
        }),
      }),
    ).toBeNull();
  });

  it("builds MiniMax prompt tags by attachment order", () => {
    expect(
      referencePromptTagHint(
        normalizeGenerateMediaRefs({
          referenceImageAssetIds: ["i1", "i2"],
          referenceVideoAssetIds: ["v1"],
        }),
      ),
    ).toBe("<Picture 1> <Picture 2> <Video 1>");
    expect(
      referencePromptTagHint(
        normalizeGenerateMediaRefs({
          referenceImageAssetIds: ["i1"],
          timelineAudio: "full_mix",
          referenceAudioAssetIds: ["a1"],
        }),
      ),
    ).toBe("<Picture 1> <Audio 1> <Audio 2>");
  });

  it("trims extra audio when a timeline clip is attached", () => {
    const refs = normalizeGenerateMediaRefs({
      referenceImageAssetIds: ["img-1"],
      timelineAudio: "full_mix",
      referenceAudioAssetIds: ["a1", "a2", "a3"],
    });
    expect(refs.referenceAudioAssetIds).toEqual(["a1", "a2"]);
    expect(
      validateGenerateMediaRefs({
        intentId: "reference_to_video",
        refs,
      }),
    ).toBeNull();
  });

  it("keeps previous/next clip stills as picture slots", () => {
    const refs = normalizeGenerateMediaRefs({
      referenceImageAssetIds: [
        TIMELINE_IMAGE_PREVIOUS,
        "img-1",
        TIMELINE_IMAGE_NEXT,
      ],
    });
    expect(refs.referenceImageAssetIds).toEqual([
      TIMELINE_IMAGE_PREVIOUS,
      "img-1",
      TIMELINE_IMAGE_NEXT,
    ]);
    expect(isTimelineImageRefId(TIMELINE_IMAGE_PREVIOUS)).toBe(true);
    expect(timelineImageRefLabel(TIMELINE_IMAGE_NEXT)).toBe("Next clip");
    expect(
      validateGenerateMediaRefs({
        intentId: "reference_to_video",
        refs,
      }),
    ).toBeNull();
    expect(
      referencePromptTagHint(refs),
    ).toBe("<Picture 1> <Picture 2> <Picture 3>");
  });

  it("caps MiniMax H3 reference counts", () => {
    expect(
      validateGenerateMediaRefs({
        intentId: "reference_to_video",
        refs: normalizeGenerateMediaRefs({
          referenceImageAssetIds: Array.from({ length: 10 }, (_, i) => `i${i}`),
        }),
      }),
    ).toMatch(/at most 9/i);
  });

  it("picks the previous timeline video as a default driving clip", () => {
    const placeholder: TimelineClip = {
      id: "ph",
      label: "gap",
      startSec: 10,
      endSec: 19,
      lane: "video",
      isAddAssetPlaceholder: true,
    };
    const prev: TimelineClip = {
      id: "c1",
      label: "shot",
      startSec: 0,
      endSec: 10,
      lane: "video",
      kind: "video",
      assetId: "vid-9",
    };
    expect(previousTimelineVideoAssetId([prev, placeholder], placeholder)).toBe(
      "vid-9",
    );
  });
});
