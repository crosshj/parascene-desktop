import { describe, expect, it } from "vitest";
import type { ReplicateInputField } from "../../replicate/replicateClient";
import {
  applyReplicateTweaksToInput,
  discoverReplicateTweakFields,
  normalizeReplicateTweaks,
  parseReplicateVideoTweaks,
} from "./replicateVideoTweaks";

function field(
  partial: Partial<ReplicateInputField> & { name: string },
): ReplicateInputField {
  return {
    title: null,
    typeName: "string",
    required: false,
    description: null,
    format: null,
    defaultValue: null,
    enumValues: null,
    minimum: null,
    maximum: null,
    fileLike: false,
    arrayItemFileLike: false,
    ...partial,
  };
}

const veoInputs = [
  field({
    name: "resolution",
    enumValues: ["720p", "1080p"],
    defaultValue: "1080p",
  }),
  field({ name: "generate_audio", typeName: "boolean", defaultValue: true }),
  field({ name: "negative_prompt", typeName: "string" }),
  field({ name: "seed", typeName: "integer" }),
];

const klingMotionInputs = [
  field({
    name: "mode",
    enumValues: ["std", "pro"],
    defaultValue: "pro",
  }),
  field({
    name: "character_orientation",
    enumValues: ["image", "video"],
    defaultValue: "image",
  }),
  field({
    name: "keep_original_sound",
    typeName: "boolean",
    defaultValue: true,
  }),
];

describe("discoverReplicateTweakFields", () => {
  it("finds Veo-style and Kling motion fields", () => {
    const veo = discoverReplicateTweakFields(veoInputs);
    expect(veo.resolution?.name).toBe("resolution");
    expect(veo.audio?.name).toBe("generate_audio");
    expect(veo.negativePrompt?.name).toBe("negative_prompt");
    expect(veo.seed?.name).toBe("seed");

    const motion = discoverReplicateTweakFields(klingMotionInputs);
    expect(motion.mode?.name).toBe("mode");
    expect(motion.characterOrientation?.name).toBe("character_orientation");
    expect(motion.keepOriginalSound?.name).toBe("keep_original_sound");
  });
});

describe("normalizeReplicateTweaks", () => {
  it("defaults generateAudio to false for timeline", () => {
    const fields = discoverReplicateTweakFields(veoInputs);
    const tweaks = normalizeReplicateTweaks(fields, undefined);
    expect(tweaks.generateAudio).toBe(false);
    expect(tweaks.resolution).toBe("1080p");
    expect(tweaks.seed).toBeNull();
  });

  it("keeps valid draft values and drops invalid enums", () => {
    const fields = discoverReplicateTweakFields(veoInputs);
    const tweaks = normalizeReplicateTweaks(fields, {
      resolution: "4k",
      generateAudio: true,
      seed: 42,
      negativePrompt: "blur",
    });
    expect(tweaks.resolution).toBe("1080p");
    expect(tweaks.generateAudio).toBe(true);
    expect(tweaks.seed).toBe(42);
    expect(tweaks.negativePrompt).toBe("blur");
  });
});

describe("applyReplicateTweaksToInput", () => {
  it("writes only set fields and omits empty seed/negative", () => {
    const fields = discoverReplicateTweakFields(veoInputs);
    const input: Record<string, unknown> = { prompt: "hi" };
    applyReplicateTweaksToInput(input, fields, {
      resolution: "720p",
      generateAudio: false,
      negativePrompt: "  ",
      seed: null,
    });
    expect(input).toEqual({
      prompt: "hi",
      resolution: "720p",
      generate_audio: false,
    });
  });

  it("applies motion-match tweaks", () => {
    const fields = discoverReplicateTweakFields(klingMotionInputs);
    const input: Record<string, unknown> = {};
    applyReplicateTweaksToInput(input, fields, {
      mode: "std",
      characterOrientation: "video",
      keepOriginalSound: false,
    });
    expect(input).toEqual({
      mode: "std",
      character_orientation: "video",
      keep_original_sound: false,
    });
  });
});

describe("parseReplicateVideoTweaks", () => {
  it("parses draft blobs", () => {
    expect(
      parseReplicateVideoTweaks({
        resolution: "720p",
        generateAudio: false,
        seed: 3.9,
      }),
    ).toEqual({
      resolution: "720p",
      generateAudio: false,
      seed: 3,
    });
    expect(parseReplicateVideoTweaks(null)).toBeUndefined();
  });
});
