import { describe, expect, it } from "vitest";
import {
  draftAudioMode,
  draftContinuityMode,
  findResumableAddAssetPlaceholders,
} from "./addAssetGenerationResume";
import type { TimelineClip } from "../../project/types";

function placeholder(
  id: string,
  draft: TimelineClip["addAssetDraft"],
): TimelineClip {
  return {
    id,
    label: "0:09",
    startSec: 0,
    endSec: 9,
    lane: "video",
    kind: "video",
    isAddAssetPlaceholder: true,
    addAssetDraft: draft,
  };
}

describe("findResumableAddAssetPlaceholders", () => {
  it("returns placeholders with a persisted generation job", () => {
    const timeline = [
      placeholder("a", {
        generationJob: {
          status: "waiting",
          provider: "replicate",
          startedAt: "2026-01-01T00:00:00.000Z",
          replicatePredictionId: "pred-1",
        },
      }),
      placeholder("b", { prompt: "no job" }),
      {
        id: "real",
        label: "clip",
        startSec: 0,
        endSec: 3,
        lane: "video" as const,
        kind: "video" as const,
        assetId: "vid",
      },
    ];
    const found = findResumableAddAssetPlaceholders(timeline);
    expect(found).toHaveLength(1);
    expect(found[0]?.clip.id).toBe("a");
    expect(found[0]?.job.replicatePredictionId).toBe("pred-1");
  });

  it("includes starting jobs so reconcile can mark them interrupted", () => {
    const timeline = [
      placeholder("s", {
        generationJob: {
          status: "starting",
          provider: "parascene_blue",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ];
    expect(findResumableAddAssetPlaceholders(timeline)).toHaveLength(1);
  });
});

describe("draft helpers", () => {
  it("defaults audio and continuity modes", () => {
    expect(draftAudioMode(undefined)).toBe("vocals");
    expect(draftAudioMode({ audioMode: "none" })).toBe("none");
    expect(draftContinuityMode(undefined)).toBe("start_frame");
    expect(draftContinuityMode({ continuityMode: "first_last" })).toBe(
      "first_last",
    );
  });
});
