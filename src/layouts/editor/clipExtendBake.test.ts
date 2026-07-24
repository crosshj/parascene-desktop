import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import {
  clipHasFreshExtendBake,
  clipNeedsExtendBake,
  clipExtendLoopLineFractions,
  clipExtendPongSegmentFractions,
  computeExtendBakeKey,
  computeExtendBakeTargetSec,
  mergeExtendBakeFields,
} from "./clipExtendBake";

function clip(
  partial: Partial<TimelineClip> &
    Pick<TimelineClip, "id" | "startSec" | "endSec">,
): TimelineClip {
  return {
    label: partial.label ?? partial.id,
    lane: partial.lane ?? "video",
    kind: partial.kind ?? "video",
    ...partial,
  };
}

describe("clipExtendBake", () => {
  it("bakes to the next whole repeat unit on disk", () => {
    const extended = clip({
      id: "v1",
      startSec: 0,
      endSec: 9.5,
      assetId: "a1",
      inSec: 0,
      outSec: 9,
      extendSourceSpanSec: 9,
    });
    expect(computeExtendBakeTargetSec(extended)).toBe(18);
  });

  it("detects when an extended clip needs a bake", () => {
    const extended = clip({
      id: "v1",
      startSec: 0,
      endSec: 10,
      assetId: "a1",
      inSec: 0,
      outSec: 9,
      extendSourceSpanSec: 9,
    });
    expect(clipNeedsExtendBake(extended)).toBe(true);
    expect(computeExtendBakeKey(extended)).toContain("a1");
  });

  it("treats a bake as fresh while timeline stays within cached cover", () => {
    const extended = clip({
      id: "v1",
      startSec: 0,
      endSec: 9.5,
      assetId: "a1",
      inSec: 0,
      outSec: 9,
      extendSourceSpanSec: 9,
    });
    const key = computeExtendBakeKey(extended);
    const baked = {
      ...extended,
      extendBakeKey: key ?? undefined,
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 18,
    };
    expect(clipHasFreshExtendBake(baked)).toBe(true);
    expect(clipNeedsExtendBake(baked)).toBe(false);

    const longerStillCovered = { ...baked, endSec: 17 };
    expect(clipHasFreshExtendBake(longerStillCovered)).toBe(true);
  });

  it("requires rebake when settings change but keeps prior bake metadata", () => {
    const key = computeExtendBakeKey(
      clip({
        id: "v1",
        startSec: 0,
        endSec: 9.5,
        assetId: "a1",
        inSec: 0,
        outSec: 9,
        extendSourceSpanSec: 9,
      }),
    );
    const baked = clip({
      id: "v1",
      startSec: 0,
      endSec: 9.5,
      assetId: "a1",
      inSec: 0,
      outSec: 9,
      extendSourceSpanSec: 9,
      extendBakeKey: key ?? undefined,
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 18,
    });
    const pingPong = { ...baked, extendPingPong: true as const };
    expect(clipNeedsExtendBake(pingPong)).toBe(true);
    expect(mergeExtendBakeFields(baked, pingPong)).toEqual({
      extendBakeKey: key,
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 18,
    });
    expect(clipNeedsExtendBake(baked)).toBe(false);
  });

  it("requires rebake when timeline exceeds cached cover", () => {
    const key = computeExtendBakeKey(
      clip({
        id: "v1",
        startSec: 0,
        endSec: 9.5,
        assetId: "a1",
        inSec: 0,
        outSec: 9,
        extendSourceSpanSec: 9,
      }),
    );
    const baked = clip({
      id: "v1",
      startSec: 0,
      endSec: 18.5,
      assetId: "a1",
      inSec: 0,
      outSec: 9,
      extendSourceSpanSec: 9,
      extendBakeKey: key ?? undefined,
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 18,
    });
    expect(clipNeedsExtendBake(baked)).toBe(true);
    expect(computeExtendBakeTargetSec(baked)).toBe(27);
  });

  it("keeps bake when timeline grows but still fits cover", () => {
    const prev = clip({
      id: "v1",
      startSec: 0,
      endSec: 9.5,
      assetId: "a1",
      inSec: 0,
      outSec: 9,
      extendSourceSpanSec: 9,
      extendBakeKey: computeExtendBakeKey(
        clip({
          id: "v1",
          startSec: 0,
          endSec: 9.5,
          assetId: "a1",
          inSec: 0,
          outSec: 9,
          extendSourceSpanSec: 9,
        }),
      ) ?? undefined,
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 18,
    });
    const next = { ...prev, endSec: 11 };
    expect(mergeExtendBakeFields(prev, next)).toEqual({
      extendBakeKey: prev.extendBakeKey,
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 18,
    });
  });

  it("clears bake metadata when clip is no longer extended", () => {
    const prev = clip({
      id: "v1",
      startSec: 0,
      endSec: 9.5,
      assetId: "a1",
      inSec: 0,
      outSec: 9,
      extendSourceSpanSec: 9,
      extendBakeKey: "key",
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 18,
    });
    const next = { ...prev, endSec: 9, extendSourceSpanSec: undefined };
    expect(mergeExtendBakeFields(prev, next)).toEqual({
      extendBakeKey: undefined,
      extendBakePath: undefined,
      extendBakeCoverSec: undefined,
    });
  });

  it("marks loop boundaries after the source-trim divit", () => {
    const looped = clip({
      id: "v1",
      startSec: 0,
      endSec: 25,
      assetId: "a1",
      inSec: 0,
      outSec: 9,
      extendSourceSpanSec: 9,
    });
    expect(clipExtendLoopLineFractions(looped)).toEqual([18 / 25]);

    const pingPong = clip({
      id: "v2",
      startSec: 0,
      endSec: 35,
      assetId: "a1",
      inSec: 0,
      outSec: 9,
      extendSourceSpanSec: 9,
      extendPingPong: true,
    });
    expect(clipExtendLoopLineFractions(pingPong)).toEqual([18 / 35, 27 / 35]);
    expect(clipExtendPongSegmentFractions(pingPong)).toEqual([
      { left: 9 / 35, width: 9 / 35 },
      { left: 27 / 35, width: 8 / 35 },
    ]);
  });

  it("needs rebake when ping-pong toggles on but keeps prior bake metadata", () => {
    const looped = clip({
      id: "v1",
      startSec: 0,
      endSec: 9.5,
      assetId: "a1",
      inSec: 0,
      outSec: 9,
      extendSourceSpanSec: 9,
      extendBakeKey: computeExtendBakeKey(
        clip({
          id: "v1",
          startSec: 0,
          endSec: 9.5,
          assetId: "a1",
          inSec: 0,
          outSec: 9,
          extendSourceSpanSec: 9,
        }),
      ) ?? undefined,
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 18,
    });
    const pingPong = { ...looped, extendPingPong: true as const };
    expect(clipNeedsExtendBake(pingPong)).toBe(true);
    expect(mergeExtendBakeFields(looped, pingPong)).toEqual({
      extendBakeKey: looped.extendBakeKey,
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 18,
    });
  });

  it("needs rebake when ping-pong toggles off but keeps prior bake metadata", () => {
    const pingPong = clip({
      id: "v1",
      startSec: 0,
      endSec: 9.5,
      assetId: "a1",
      inSec: 0,
      outSec: 9,
      extendSourceSpanSec: 9,
      extendPingPong: true,
      extendBakeKey: computeExtendBakeKey(
        clip({
          id: "v1",
          startSec: 0,
          endSec: 9.5,
          assetId: "a1",
          inSec: 0,
          outSec: 9,
          extendSourceSpanSec: 9,
          extendPingPong: true,
        }),
      ) ?? undefined,
      extendBakePath: "/tmp/extend-ping.mp4",
      extendBakeCoverSec: 18,
    });
    const looped = { ...pingPong, extendPingPong: undefined };
    expect(clipNeedsExtendBake(looped)).toBe(true);
    expect(mergeExtendBakeFields(pingPong, looped)).toEqual({
      extendBakeKey: pingPong.extendBakeKey,
      extendBakePath: "/tmp/extend-ping.mp4",
      extendBakeCoverSec: 18,
    });
  });
});
