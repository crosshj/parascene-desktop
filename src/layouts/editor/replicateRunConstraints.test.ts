import { describe, expect, it } from "vitest";
import type { ReplicateInputField } from "../../replicate/replicateClient";
import {
  durationConstraintFromField,
  durationFits,
  formatDurationConstraint,
  mapReplicateVideoFields,
  modelIncompatibilityReason,
  nearestAllowedDuration,
  replicateVideoCapability,
  supportsContinuity,
  validateReplicateRun,
} from "./replicateRunConstraints";

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

const veoInputs: ReplicateInputField[] = [
  field({ name: "prompt", typeName: "string" }),
  field({
    name: "duration",
    typeName: "integer",
    enumValues: ["4", "6", "8"],
  }),
  field({
    name: "aspect_ratio",
    typeName: "string",
    enumValues: ["16:9", "9:16"],
  }),
  field({ name: "image", typeName: "uri", fileLike: true }),
  field({ name: "last_frame", typeName: "uri", fileLike: true }),
];

const klingMotionInputs: ReplicateInputField[] = [
  field({ name: "prompt", typeName: "string" }),
  field({ name: "image", typeName: "uri", fileLike: true }),
  field({ name: "video", typeName: "uri", fileLike: true }),
  field({
    name: "mode",
    typeName: "string",
    enumValues: ["std", "pro"],
  }),
];

const klingVideoInputs: ReplicateInputField[] = [
  field({ name: "prompt", typeName: "string" }),
  field({
    name: "duration",
    typeName: "integer",
    minimum: 3,
    maximum: 15,
  }),
  field({
    name: "aspect_ratio",
    typeName: "string",
    enumValues: ["16:9", "9:16", "1:1"],
    description: "Aspect ratio. Ignored when start_image is provided.",
  }),
  field({ name: "start_image", typeName: "uri", fileLike: true }),
  field({ name: "end_image", typeName: "uri", fileLike: true }),
];

describe("mapReplicateVideoFields", () => {
  it("maps Veo-style image + last_frame", () => {
    const map = mapReplicateVideoFields(veoInputs);
    expect(map.startImage).toBe("image");
    expect(map.endImage).toBe("last_frame");
    expect(map.duration).toBe("duration");
  });

  it("maps Kling start_image + end_image", () => {
    const map = mapReplicateVideoFields(klingVideoInputs);
    expect(map.startImage).toBe("start_image");
    expect(map.endImage).toBe("end_image");
  });

  it("maps motion-control image + video", () => {
    const map = mapReplicateVideoFields(klingMotionInputs);
    expect(map.characterImage).toBe("image");
    expect(map.motionVideo).toBe("video");
    expect(map.endImage).toBeNull();
  });
});

describe("replicateVideoCapability", () => {
  it("classifies start-end and motion models", () => {
    expect(replicateVideoCapability(veoInputs)).toEqual({
      startOnly: true,
      startEnd: true,
      motionControl: false,
    });
    expect(replicateVideoCapability(klingMotionInputs)).toEqual({
      startOnly: true,
      startEnd: false,
      motionControl: true,
    });
    expect(supportsContinuity(replicateVideoCapability(veoInputs), "first_last")).toBe(
      true,
    );
    expect(
      supportsContinuity(replicateVideoCapability(klingMotionInputs), "motion_match"),
    ).toBe(true);
  });
});

describe("duration helpers", () => {
  it("parses enum and range constraints", () => {
    expect(durationConstraintFromField(veoInputs[1]!)).toEqual({
      kind: "enum",
      values: [4, 6, 8],
    });
    expect(durationConstraintFromField(klingVideoInputs[1]!)).toEqual({
      kind: "range",
      min: 3,
      max: 15,
    });
  });

  it("fits and nearest", () => {
    const veo = durationConstraintFromField(veoInputs[1]!)!;
    expect(durationFits(8, veo)).toBe(true);
    expect(durationFits(12, veo)).toBe(false);
    expect(nearestAllowedDuration(12, veo)).toBe(8);
    expect(formatDurationConstraint(veo)).toBe("4, 6, 8s");
  });
});

describe("validateReplicateRun", () => {
  it("blocks Veo when gap is outside enum", () => {
    const result = validateReplicateRun({
      inputs: veoInputs,
      continuity: "first_last",
      durationSec: 12,
      aspectRatio: "16:9",
      hasStartFrame: true,
      hasEndFrame: true,
      hasCharacterImage: false,
      hasMotionVideo: false,
      prompt: "a bird flies",
    });
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toMatch(/12\.0s/);
    expect(result.blockers[0]).toMatch(/4, 6, 8s/);
  });

  it("allows explicit nearest duration snap", () => {
    const result = validateReplicateRun({
      inputs: veoInputs,
      continuity: "first_last",
      durationSec: 12,
      aspectRatio: "16:9",
      useNearestDuration: true,
      hasStartFrame: true,
      hasEndFrame: true,
      hasCharacterImage: false,
      hasMotionVideo: false,
      prompt: "a bird flies",
    });
    expect(result.ok).toBe(true);
    expect(result.predictDurationSec).toBe(8);
    expect(result.durationSnapped).toBe(true);
  });

  it("blocks unsupported aspect unless ignored with image", () => {
    const blocked = validateReplicateRun({
      inputs: veoInputs,
      continuity: "start_frame",
      durationSec: 8,
      aspectRatio: "4:5",
      hasStartFrame: false,
      hasEndFrame: false,
      hasCharacterImage: false,
      hasMotionVideo: false,
      prompt: "x",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers.some((b) => b.includes("4:5"))).toBe(true);

    const ignored = validateReplicateRun({
      inputs: klingVideoInputs,
      continuity: "start_frame",
      durationSec: 9,
      aspectRatio: "4:5",
      hasStartFrame: true,
      hasEndFrame: false,
      hasCharacterImage: false,
      hasMotionVideo: false,
      prompt: "x",
    });
    expect(ignored.ok).toBe(true);
    expect(ignored.notes.some((n) => n.includes("ignored"))).toBe(true);
  });

  it("requires motion inputs for motion_match", () => {
    const result = validateReplicateRun({
      inputs: klingMotionInputs,
      continuity: "motion_match",
      durationSec: 5,
      aspectRatio: "16:9",
      hasStartFrame: false,
      hasEndFrame: false,
      hasCharacterImage: false,
      hasMotionVideo: false,
      prompt: "dance",
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.length).toBeGreaterThanOrEqual(2);
  });
});

describe("modelIncompatibilityReason", () => {
  it("summarizes picker reasons", () => {
    expect(
      modelIncompatibilityReason(veoInputs, "first_last", 12, "16:9", true),
    ).toMatch(/Allows/);
    expect(
      modelIncompatibilityReason(veoInputs, "motion_match", 8, "16:9", true),
    ).toBe("No motion control");
    expect(
      modelIncompatibilityReason(klingVideoInputs, "start_frame", 9, "16:9", true),
    ).toBeNull();
  });
});
