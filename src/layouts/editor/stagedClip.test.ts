import { describe, expect, it } from "vitest";
import {
  applyDraftToTimelineClip,
  defaultSlideshowDraft,
  defaultStagedClipDraft,
  formatStagedDuration,
  framingClassName,
  framingUsesProjectMatte,
  framingViewportStyle,
  isProvisionalOutSec,
  normalizeFraming,
  normalizeSlideshowRecipe,
  parseStagedClipPayload,
  remapTrimForReverse,
  serializeStagedClip,
  slideshowOrderIndices,
  slideshowRecipesEqual,
  stagedClipDuration,
  targetLaneForDraft,
  timelineClipToStagedDraft,
  videoStretchStyle,
} from "./stagedClip";

describe("stagedClip", () => {
  it("builds defaults by kind", () => {
    const image = defaultStagedClipDraft({
      assetId: "a1",
      label: "Logo",
      kind: "image",
    });
    expect(stagedClipDuration(image)).toBe(10);

    const video = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 12.5,
    });
    expect(video.outSec).toBe(12.5);
    expect(video.includeAudio).toBe(false);
    expect(targetLaneForDraft(video)).toBe("video");
  });

  it("normalizes framing and maps fill/stretch onto the project matte", () => {
    expect(normalizeFraming("stretch")).toBe("stretch");
    expect(normalizeFraming("fill")).toBe("fill");
    expect(normalizeFraming("fit")).toBe("fit");
    expect(normalizeFraming(undefined)).toBe("fit");
    expect(framingClassName("stretch")).toBe("is-framing-stretch");
    expect(framingUsesProjectMatte("fit")).toBe(false);
    expect(framingUsesProjectMatte("fill")).toBe(true);
    expect(framingUsesProjectMatte("stretch")).toBe(true);

    // 16:9 stage with 4:5 matte — Stretch/Fill shrink to the matte box.
    const stageW = 1600;
    const stageH = 900;
    const matteW = 720;
    const matteH = 900;
    expect(framingViewportStyle("fit", stageW, stageH, matteW, matteH)).toBeUndefined();
    expect(framingViewportStyle("stretch", stageW, stageH, matteW, matteH)).toEqual({
      width: 720,
      height: 900,
      left: 440,
      top: 0,
    });
    expect(framingViewportStyle("fill", stageW, stageH, matteW, matteH)).toEqual({
      width: 720,
      height: 900,
      left: 440,
      top: 0,
    });
    // Project matches stage — no inset needed.
    expect(
      framingViewportStyle("stretch", stageW, stageH, stageW, stageH),
    ).toBeUndefined();
  });

  it("computes non-uniform stretch into a taller project frame", () => {
    // 16:9 media into a 4:5 box: contain letterboxes vertically, then scale Y.
    const style = videoStretchStyle(1920, 1080, 400, 500);
    expect(style).not.toBeNull();
    expect(style!.objectFit).toBe("contain");
    expect(style!.transformOrigin).toBe("center center");
    // fitted = 400×225 → scale(1, 500/225)
    expect(style!.transform).toBe(`scale(1, ${500 / 225})`);
  });

  it("marks Out as provisional until source duration is known", () => {
    const pending = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
    });
    expect(pending.outSec).toBe(10);
    expect(isProvisionalOutSec(pending)).toBe(true);

    const known = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 42.5,
    });
    expect(known.outSec).toBe(42.5);
    expect(isProvisionalOutSec(known)).toBe(false);
  });

  it("serializes and parses drag payload", () => {
    const draft = defaultStagedClipDraft({
      assetId: "a1",
      label: "Clip",
      kind: "audio",
      sourceDurationSec: 20,
    });
    const parsed = parseStagedClipPayload(serializeStagedClip(draft));
    expect(parsed?.assetId).toBe("a1");
    expect(parsed?.kind).toBe("audio");
    expect(targetLaneForDraft(parsed!)).toBe("audio");
  });

  it("formats duration labels", () => {
    expect(formatStagedDuration(3)).toBe("0:03");
    expect(formatStagedDuration(65)).toBe("1:05");
  });

  it("maps timeline clip settings into a staged draft", () => {
    const draft = timelineClipToStagedDraft({
      assetId: "a1",
      label: "3.0s",
      kind: "image",
      startSec: 2,
      endSec: 5,
      inSec: 0,
      outSec: 3,
      includeAudio: false,
      transform: "kenBurns",
      framing: "fill",
      thumbUrl: "asset://thumb",
    });
    expect(draft).toMatchObject({
      assetId: "a1",
      kind: "image",
      inSec: 0,
      outSec: 3,
      transform: "kenBurns",
      framing: "fill",
      thumbUrl: "asset://thumb",
    });
    expect(timelineClipToStagedDraft({ label: "x", startSec: 0, endSec: 1 })).toBeNull();
  });

  it("maps add-asset placeholder timeline clips into a staged draft", () => {
    const draft = timelineClipToStagedDraft({
      label: "9.0s",
      kind: "image",
      startSec: 4,
      endSec: 13,
      inSec: 0,
      outSec: 9,
      isAddAssetPlaceholder: true,
    });
    expect(draft).toMatchObject({
      assetId: "",
      kind: "image",
      inSec: 0,
      outSec: 9,
      isAddAssetPlaceholder: true,
    });
  });

  it("treats audio-lane clips as audio (no include-audio)", () => {
    const draft = timelineClipToStagedDraft({
      assetId: "a1",
      label: "4.0s",
      lane: "audio",
      startSec: 0,
      endSec: 4,
    });
    expect(draft?.kind).toBe("audio");
    expect(draft?.includeAudio).toBe(false);
  });

  it("applies draft edits back onto a timeline clip", () => {
    const clip = {
      id: "c1",
      label: "3.0s",
      startSec: 5,
      endSec: 8,
      assetId: "a1",
      kind: "image" as const,
      inSec: 0,
      outSec: 3,
      includeAudio: false,
      transform: "hold" as const,
      framing: "fit" as const,
      thumbUrl: null,
    };
    const draft = defaultStagedClipDraft({
      assetId: "a1",
      label: "Logo",
      kind: "image",
    });
    draft.outSec = 5;
    draft.transform = "kenBurns";
    draft.framing = "fill";
    const next = applyDraftToTimelineClip(clip, draft);
    expect(next.startSec).toBe(5);
    expect(next.endSec).toBe(10);
    expect(next.transform).toBe("kenBurns");
    expect(next.framing).toBe("fill");
    expect(next.label).toBe("5.0s");
  });

  it("round-trips reverse on staged payloads", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 10,
    });
    draft.reverse = true;
    draft.inSec = 2;
    draft.outSec = 6;
    const parsed = parseStagedClipPayload(serializeStagedClip(draft));
    expect(parsed?.reverse).toBe(true);

    const clip = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "4.0s",
        startSec: 0,
        endSec: 4,
        assetId: "v1",
        kind: "video",
      },
      draft,
    );
    expect(clip.reverse).toBe(true);
    expect(timelineClipToStagedDraft(clip)?.reverse).toBe(true);
  });

  it("mirrors in/out when toggling reverse", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 10,
    });
    draft.inSec = 2;
    draft.outSec = 5;
    expect(remapTrimForReverse(draft, 10)).toEqual({ inSec: 5, outSec: 8 });
  });

  it("builds and round-trips slideshow drafts", () => {
    const draft = defaultSlideshowDraft({
      imageAssetIds: ["i1", "i2", "i3"],
      label: "Slideshow (3)",
      thumbUrl: "asset://t",
      durationSec: 12,
      mode: "even",
    });
    expect(draft.kind).toBe("slideshow");
    expect(draft.assetId).toBe("i1");
    expect(draft.outSec).toBe(12);
    expect(draft.slideshow?.imageAssetIds).toEqual(["i1", "i2", "i3"]);
    expect(targetLaneForDraft(draft)).toBe("video");

    const parsed = parseStagedClipPayload(serializeStagedClip(draft));
    expect(parsed?.kind).toBe("slideshow");
    expect(parsed?.slideshow?.imageAssetIds).toEqual(["i1", "i2", "i3"]);

    const clip = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "10.0s",
        startSec: 4,
        endSec: 14,
        assetId: "i1",
        kind: "slideshow",
        slideshow: {
          imageAssetIds: ["i1", "i2", "i3"],
          mode: "even",
        },
        bakeKey: "old",
        bakePath: "/tmp/old.mp4",
      },
      { ...draft, outSec: 8, framing: "fill" },
    );
    expect(clip.endSec).toBe(12);
    expect(clip.framing).toBe("fill");
    expect(clip.bakePath).toBeNull();
    expect(clip.bakeKey).toBeNull();
    expect(
      slideshowRecipesEqual(clip.slideshow, {
        imageAssetIds: ["i1", "i2", "i3"],
        mode: "even",
      }),
    ).toBe(true);

    const restored = timelineClipToStagedDraft(clip);
    expect(restored?.kind).toBe("slideshow");
    expect(restored?.slideshow?.imageAssetIds).toEqual(["i1", "i2", "i3"]);
  });

  it("keeps a rendered slideshow bake when trimming its source range", () => {
    const draft = defaultSlideshowDraft({
      imageAssetIds: ["i1", "i2"],
      label: "Slideshow",
      durationSec: 10,
      mode: "even",
    });
    const clip = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "10.0s",
        startSec: 4,
        endSec: 14,
        kind: "slideshow",
        inSec: 0,
        outSec: 10,
        framing: "fit",
        slideshow: draft.slideshow,
        bakeKey: "bake-1",
        bakePath: "/tmp/bake.mp4",
      },
      { ...draft, inSec: 2, outSec: 8 },
    );

    expect(clip.startSec).toBe(4);
    expect(clip.endSec).toBe(10);
    expect(clip.bakeKey).toBe("bake-1");
    expect(clip.bakePath).toBe("/tmp/bake.mp4");
  });

  it("round-trips random flag and deterministically shuffles by seed", () => {
    const draft = defaultSlideshowDraft({
      imageAssetIds: ["i1", "i2", "i3", "i4"],
      label: "Random",
      random: true,
    });
    expect(draft.slideshow?.mode).toBe("even");
    expect(draft.slideshow?.random).toBe(true);
    expect(draft.slideshow?.seed).toEqual(expect.any(Number));

    const parsed = parseStagedClipPayload(serializeStagedClip(draft));
    expect(parsed?.slideshow).toEqual(draft.slideshow);
    expect(slideshowOrderIndices(8, 123)).toEqual(
      slideshowOrderIndices(8, 123),
    );
    expect(slideshowOrderIndices(8, 123)).not.toEqual(
      slideshowOrderIndices(8, 456),
    );
  });

  it("migrates legacy mode:random to even + random", () => {
    const recipe = normalizeSlideshowRecipe({
      imageAssetIds: ["i1", "i2"],
      mode: "random",
      seed: 42,
    });
    expect(recipe).toEqual({
      imageAssetIds: ["i1", "i2"],
      mode: "even",
      random: true,
      seed: 42,
    });
  });

  it("preserves named beat algorithms and upgrades legacy beat mode", () => {
    for (const mode of [
      "beat_classic",
      "beat_grid",
      "beat_drums",
      "beat_energy",
    ] as const) {
      expect(
        normalizeSlideshowRecipe({
          imageAssetIds: ["i1", "i2"],
          mode,
        })?.mode,
      ).toBe(mode);
    }
    expect(
      normalizeSlideshowRecipe({
        imageAssetIds: ["i1", "i2"],
        mode: "beat",
      })?.mode,
    ).toBe("beat_energy");
  });

  it("clamps and round-trips sensitivity", () => {
    expect(
      normalizeSlideshowRecipe({
        imageAssetIds: ["i1", "i2"],
        mode: "beat_classic",
        sensitivity: 0.8,
      })?.sensitivity,
    ).toBe(0.8);
    expect(
      normalizeSlideshowRecipe({
        imageAssetIds: ["i1", "i2"],
        mode: "beat_classic",
        sensitivity: 5,
      })?.sensitivity,
    ).toBe(1);
    expect(
      normalizeSlideshowRecipe({
        imageAssetIds: ["i1", "i2"],
        mode: "beat_classic",
      })?.sensitivity,
    ).toBeUndefined();
  });
});
