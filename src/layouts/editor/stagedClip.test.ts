import { describe, expect, it } from "vitest";
import { clipNeedsExtendBake } from "./clipExtendBake";
import {
  applyDraftToTimelineClip,
  addAssetDraftFromGeneration,
  clipTimelineMoveEnabled,
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
  patchStagedClipInOut,
  remapTrimForReverse,
  resolveExtendPingPong,
  serializeStagedClip,
  slideshowOrderIndices,
  slideshowRecipesEqual,
  stagedClipDuration,
  stagedDraftForDuplicateGenerate,
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
      zoom: 1.75,
      centerX: 12,
      centerY: -8,
      thumbUrl: "asset://thumb",
    });
    expect(draft).toMatchObject({
      assetId: "a1",
      kind: "image",
      inSec: 0,
      outSec: 3,
      transform: "kenBurns",
      framing: "fill",
      zoom: 1.75,
      centerX: 12,
      centerY: -8,
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

  it("mirrors in/out against the real source duration, not a placeholder max", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 8.17,
    });
    draft.inSec = 0;
    draft.outSec = 4.7;
    // Using the media duration keeps the flipped region on the scrubber.
    expect(remapTrimForReverse(draft, 8.17)).toEqual({
      inSec: expect.closeTo(3.47, 2),
      outSec: expect.closeTo(8.17, 2),
    });
    // A placeholder 120s max (old staging bug) sends the region off-screen.
    expect(remapTrimForReverse(draft, 120)).toEqual({
      inSec: expect.closeTo(115.3, 2),
      outSec: 120,
    });
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

  it("shifts startSec when trimming In on a locked clip", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 20,
    });
    draft.inSec = 1;
    draft.outSec = 5;
    const next = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "5.0s",
        startSec: 10,
        endSec: 15,
        assetId: "v1",
        kind: "video",
        inSec: 0,
        outSec: 5,
        timelineLocked: true,
      },
      draft,
    );
    expect(next.startSec).toBe(11);
    expect(next.endSec).toBe(15);
    expect(next.inSec).toBe(1);
    expect(next.outSec).toBe(5);
  });

  it("keeps startSec when trimming Out on a locked clip", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 20,
    });
    draft.inSec = 0;
    draft.outSec = 4;
    const next = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "5.0s",
        startSec: 10,
        endSec: 15,
        assetId: "v1",
        kind: "video",
        inSec: 0,
        outSec: 5,
        timelineLocked: true,
      },
      draft,
    );
    expect(next.startSec).toBe(10);
    expect(next.endSec).toBe(14);
    expect(next.outSec).toBe(4);
  });

  it("unlocks when Sync to timeline is turned off", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 20,
    });
    draft.inSec = 0;
    draft.outSec = 5;
    draft.timelineLocked = false;
    const next = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "5.0s",
        startSec: 10,
        endSec: 15,
        assetId: "v1",
        kind: "video",
        inSec: 0,
        outSec: 5,
        timelineLocked: true,
      },
      draft,
    );
    expect(next.timelineLocked).toBeUndefined();
    expect(clipTimelineMoveEnabled(next)).toBe(true);
  });

  it("keeps lock when draft omits timelineLocked", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 20,
    });
    draft.inSec = 1;
    draft.outSec = 5;
    // undefined = "not changing lock" (e.g. unrelated field edit)
    draft.timelineLocked = undefined;
    const next = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "5.0s",
        startSec: 10,
        endSec: 15,
        assetId: "v1",
        kind: "video",
        inSec: 0,
        outSec: 5,
        timelineLocked: true,
      },
      draft,
    );
    expect(next.timelineLocked).toBe(true);
  });

  it("extends video timeline duration without changing source trim", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 10,
    });
    draft.inSec = 0;
    draft.outSec = 5;
    draft.timelineDurationSec = 8;
    const next = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "5.0s",
        startSec: 10,
        endSec: 15,
        assetId: "v1",
        kind: "video",
        inSec: 0,
        outSec: 5,
      },
      draft,
    );
    expect(next.endSec).toBe(18);
    expect(next.outSec).toBe(5);
    expect(next.inSec).toBe(0);
    expect(next.label).toBe("8.0s");
  });

  it("shortens timeline duration when trimming a non-extended video clip", () => {
    const clip = {
      id: "c1",
      label: "10.0s",
      startSec: 2,
      endSec: 12,
      assetId: "v1",
      kind: "video" as const,
      inSec: 0,
      outSec: 10,
    };
    const draft = timelineClipToStagedDraft(clip)!;
    expect(draft.timelineDurationSec).toBe(10);

    const trimmed = patchStagedClipInOut(draft, { outSec: 6 }, 10);
    expect(trimmed.outSec).toBe(6);
    expect(trimmed.timelineDurationSec).toBe(6);

    const next = applyDraftToTimelineClip(clip, trimmed);
    expect(next.startSec).toBe(2);
    expect(next.endSec).toBe(8);
    expect(next.outSec).toBe(6);
    expect(next.label).toBe("6.0s");
    expect(next.extendPingPong).toBeUndefined();
  });

  it("keeps extended timeline duration when trimming the source loop unit", () => {
    const clip = {
      id: "c1",
      label: "12.0s",
      startSec: 0,
      endSec: 12,
      assetId: "v1",
      kind: "video" as const,
      inSec: 0,
      outSec: 5,
      extendPingPong: true,
      extendSourceSpanSec: 5,
    };
    const draft = timelineClipToStagedDraft(clip)!;
    expect(draft.timelineDurationSec).toBe(12);

    const trimmed = patchStagedClipInOut(draft, { outSec: 4 }, 10);
    expect(trimmed.outSec).toBe(4);
    expect(trimmed.timelineDurationSec).toBe(12);

    const next = applyDraftToTimelineClip(clip, trimmed);
    expect(next.startSec).toBe(0);
    expect(next.endSec).toBe(12);
    expect(next.outSec).toBe(4);
  });

  it("keeps timeline ends fixed when speed changes and preserves speed under Sync", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 10,
    });
    draft.inSec = 0;
    draft.outSec = 4;
    draft.timelineDurationSec = 8;
    draft.speed = 2;
    draft.timelineLocked = true;
    const clip = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "8.0s",
        startSec: 2,
        endSec: 10,
        assetId: "v1",
        kind: "video",
        inSec: 0,
        outSec: 4,
        timelineLocked: true,
      },
      draft,
    );
    expect(clip.startSec).toBe(2);
    expect(clip.endSec).toBe(10);
    expect(clip.speed).toBe(2);
    expect(clip.timelineLocked).toBe(true);
  });

  it("defaults ping-pong when a video clip first enters extend mode", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 10,
    });
    draft.inSec = 0;
    draft.outSec = 3;
    draft.timelineDurationSec = 5;
    const clip = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "3.0s",
        startSec: 0,
        endSec: 3,
        assetId: "v1",
        kind: "video",
        inSec: 0,
        outSec: 3,
      },
      draft,
    );
    expect(clip.extendPingPong).toBe(true);
    expect(resolveExtendPingPong(5, 3, false, {}, undefined)).toBe(true);
    expect(resolveExtendPingPong(5, 3, true, { extendPingPong: true }, false)).toBe(
      undefined,
    );
  });

  it("persists ping-pong on extended video clips", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 10,
    });
    draft.inSec = 1;
    draft.outSec = 4;
    draft.timelineDurationSec = 7;
    draft.extendPingPong = true;
    const clip = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "3.0s",
        startSec: 0,
        endSec: 3,
        assetId: "v1",
        kind: "video",
        inSec: 1,
        outSec: 4,
      },
      draft,
    );
    expect(clip.extendPingPong).toBe(true);
    expect(timelineClipToStagedDraft(clip)?.extendPingPong).toBe(true);
    expect(timelineClipToStagedDraft(clip)?.timelineDurationSec).toBe(7);
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

  it("needs rebake when ping-pong toggles on but keeps bake metadata", () => {
    const clip = {
      id: "c1",
      label: "6.0s",
      startSec: 0,
      endSec: 6,
      assetId: "v1",
      kind: "video" as const,
      inSec: 0,
      outSec: 3,
      extendSourceSpanSec: 3,
      extendBakeKey: '{"v":7,"assetId":"v1","inSec":0,"outSec":3,"pingPong":false,"reverse":false}',
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 6,
    };
    const draft = timelineClipToStagedDraft(clip)!;
    draft.extendPingPong = true;
    const next = applyDraftToTimelineClip(clip, draft);
    expect(next.extendBakePath).toBe("/tmp/extend.mp4");
    expect(clipNeedsExtendBake(next)).toBe(true);
  });

  it("needs rebake when ping-pong toggles off but keeps bake metadata", () => {
    const clip = {
      id: "c1",
      label: "6.0s",
      startSec: 0,
      endSec: 6,
      assetId: "v1",
      kind: "video" as const,
      inSec: 0,
      outSec: 3,
      extendSourceSpanSec: 3,
      extendPingPong: true,
      extendBakeKey: '{"v":7,"assetId":"v1","inSec":0,"outSec":3,"pingPong":true,"reverse":false}',
      extendBakePath: "/tmp/extend-ping.mp4",
      extendBakeCoverSec: 6,
    };
    const draft = timelineClipToStagedDraft(clip)!;
    draft.extendPingPong = false;
    const next = applyDraftToTimelineClip(clip, draft);
    expect(next.extendPingPong).toBeUndefined();
    expect(next.extendBakePath).toBe("/tmp/extend-ping.mp4");
    expect(clipNeedsExtendBake(next)).toBe(true);
  });

  it("reuses bake after settings return to the baked recipe", () => {
    const clip = {
      id: "c1",
      label: "6.0s",
      startSec: 0,
      endSec: 6,
      assetId: "v1",
      kind: "video" as const,
      inSec: 0,
      outSec: 3,
      extendSourceSpanSec: 3,
      extendBakeKey: '{"v":7,"assetId":"v1","inSec":0,"outSec":3,"pingPong":false,"reverse":false}',
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 6,
    };
    const draft = timelineClipToStagedDraft(clip)!;
    draft.extendPingPong = true;
    const toggled = applyDraftToTimelineClip(clip, draft);
    expect(clipNeedsExtendBake(toggled)).toBe(true);
    const restored = applyDraftToTimelineClip(toggled, {
      ...draft,
      extendPingPong: false,
    });
    expect(clipNeedsExtendBake(restored)).toBe(false);
  });

  it("clipTimelineMoveEnabled is false when synced to timeline", () => {
    expect(clipTimelineMoveEnabled({ timelineLocked: true })).toBe(false);
    expect(clipTimelineMoveEnabled({ timelineLocked: undefined })).toBe(true);
    expect(clipTimelineMoveEnabled({})).toBe(true);
    expect(
      clipTimelineMoveEnabled({
        kind: "audio",
        lane: "audio",
        timelineLocked: true,
      }),
    ).toBe(true);
  });

  it("keeps audio clips unlocked so they can move on the timeline", () => {
    const draft = defaultStagedClipDraft({
      assetId: "a1",
      label: "Song",
      kind: "audio",
      sourceDurationSec: 30,
    });
    draft.inSec = 0;
    draft.outSec = 20;
    draft.timelineLocked = true;
    const next = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "30.0s",
        startSec: 0,
        endSec: 30,
        assetId: "a1",
        kind: "audio",
        lane: "audio",
        inSec: 0,
        outSec: 30,
        timelineLocked: true,
      },
      draft,
    );
    expect(next.timelineLocked).toBeUndefined();
    expect(clipTimelineMoveEnabled(next)).toBe(true);
    expect(next.endSec).toBe(20);
    expect(next.outSec).toBe(20);
  });

  it("seeds a duplicate-generate draft from generation provenance", () => {
    const draft = addAssetDraftFromGeneration({
      prompt: "creature walks",
      generatedAt: "2026-07-28T00:00:00.000Z",
      creationId: "c1",
      mode: "start_frame",
      model: "vidu/q3-turbo",
      provider: "replicate",
      methodId: "replicate_timeline_fill",
      audioMode: "full_mix",
      startFrameAssetId: "img-1",
      startFrameFraming: "fill",
      useNearestDuration: true,
      replicateTweaks: { resolution: "720p", seed: 42 },
    });
    expect(draft).toMatchObject({
      prompt: "creature walks",
      continuityMode: "start_frame",
      provider: "replicate",
      methodId: "replicate_timeline_fill",
      replicateModel: "vidu/q3-turbo",
      audioMode: "full_mix",
      startFrameAssetId: "img-1",
      startFrameFraming: "fill",
      useNearestDuration: true,
      replicateTweaks: { resolution: "720p", seed: 42 },
    });

    const staged = stagedDraftForDuplicateGenerate(
      {
        prompt: "x",
        generatedAt: "2026-07-28T00:00:00.000Z",
        creationId: "c1",
        model: "owner/name",
      },
      4,
    );
    expect(staged.isAddAssetPlaceholder).toBe(true);
    expect(staged.outSec).toBe(4);
    expect(staged.addAssetDraft?.provider).toBe("replicate");
    expect(staged.addAssetDraft?.methodId).toBe("replicate_timeline_fill");
    expect(staged.addAssetDraft?.replicateModel).toBe("owner/name");
  });

  it("seeds Blue WAN drafts with source audio locked to none", () => {
    const draft = addAssetDraftFromGeneration({
      prompt: "bridge fill",
      generatedAt: "2026-07-30T00:00:00.000Z",
      creationId: "c2",
      mode: "first_last",
      model: "wan_i2v",
      provider: "parascene_blue",
      methodId: "blue_timeline_fill",
    });
    expect(draft).toMatchObject({
      blueModel: "wan",
      audioMode: "none",
      continuityMode: "first_last",
      provider: "parascene_blue",
    });
  });

  it("seeds Blue LTX i2v drafts with source audio none", () => {
    const draft = addAssetDraftFromGeneration({
      prompt: "silent start",
      generatedAt: "2026-07-30T00:00:00.000Z",
      creationId: "c3",
      mode: "start_frame",
      model: "ltx_i2v",
      provider: "parascene_blue",
      methodId: "blue_timeline_fill",
    });
    expect(draft).toMatchObject({
      blueModel: "ltx",
      audioMode: "none",
      continuityMode: "start_frame",
    });
  });

  it("seeds Blue WAN text-to-video drafts with images none", () => {
    const draft = addAssetDraftFromGeneration({
      prompt: "a bird over water",
      generatedAt: "2026-08-07T00:00:00.000Z",
      creationId: "c4",
      mode: "none",
      model: "wan_t2v",
      provider: "parascene_blue",
      methodId: "blue_timeline_fill",
    });
    expect(draft).toMatchObject({
      blueModel: "wan",
      audioMode: "none",
      continuityMode: "none",
      provider: "parascene_blue",
    });
  });

  it("seeds Blue LTX text-to-video drafts with images none", () => {
    const draft = addAssetDraftFromGeneration({
      prompt: "slow pan across a room",
      generatedAt: "2026-08-07T00:00:00.000Z",
      creationId: "c5",
      mode: "none",
      model: "ltx_t2v",
      provider: "parascene_blue",
      methodId: "blue_timeline_fill",
    });
    expect(draft).toMatchObject({
      blueModel: "ltx",
      audioMode: "none",
      continuityMode: "none",
    });
  });
});
