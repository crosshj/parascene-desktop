import { describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../project/types";
import { previewDecodeBackend } from "../../preview/capabilities";
import { containRect } from "../../preview/compositor";
import { FrameCache } from "../../preview/frameCache";
import {
  emitPreviewInstrument,
  subscribePreviewInstrument,
} from "../../preview/instrument";
import {
  peekNextVisualClip,
  resolveFrameTarget,
  resolveSeamPreload,
} from "./timelineCompose";

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

describe("preview capabilities", () => {
  it("reports a decode backend id", () => {
    expect(["webcodecs", "htmlVideo"]).toContain(previewDecodeBackend());
  });
});

describe("containRect", () => {
  it("letterboxes a wide source into a square dest", () => {
    const r = containRect(1920, 1080, 200, 200);
    expect(r.dw).toBeCloseTo(200);
    expect(r.dh).toBeCloseTo(112.5);
    expect(r.dx).toBeCloseTo(0);
    expect(r.dy).toBeCloseTo(43.75);
  });

  it("pillarboxes a tall source into a wide dest", () => {
    const r = containRect(1080, 1920, 400, 200);
    expect(r.dh).toBeCloseTo(200);
    expect(r.dw).toBeCloseTo(112.5);
    expect(r.dx).toBeCloseTo(143.75);
    expect(r.dy).toBeCloseTo(0);
  });
});

describe("resolveFrameTarget", () => {
  const clips: TimelineClip[] = [
    clip({
      id: "c1",
      startSec: 0,
      endSec: 2,
      inSec: 1,
      outSec: 3,
      assetId: "vid-a",
      kind: "video",
    }),
    clip({
      id: "c2",
      startSec: 2,
      endSec: 4,
      inSec: 0,
      outSec: 2,
      assetId: "vid-b",
      kind: "video",
    }),
  ];

  it("maps timeline µs to asset + source µs for the covering clip", () => {
    const target = resolveFrameTarget(clips, Math.round(1.0 * 1e6));
    expect(target).toEqual({
      assetId: "vid-a",
      sourceTimeUs: Math.round(2 * 1e6),
      clipId: "c1",
      kind: "video",
    });
  });

  it("switches assets across a seam without returning the wrong clip", () => {
    const before = resolveFrameTarget(clips, Math.round(1.99 * 1e6));
    const after = resolveFrameTarget(clips, Math.round(2.0 * 1e6));
    expect(before?.assetId).toBe("vid-a");
    expect(after?.assetId).toBe("vid-b");
    expect(after?.sourceTimeUs).toBe(0);
  });

  it("remaps reverse clips onto the forward proxy", () => {
    const rev = [
      clip({
        id: "r1",
        startSec: 0,
        endSec: 2,
        inSec: 0,
        outSec: 2,
        assetId: "vid-r",
        kind: "video",
        reverse: true,
      }),
    ];
    const atStart = resolveFrameTarget(rev, 0);
    const atEnd = resolveFrameTarget(rev, Math.round(2 * 1e6));
    expect(atStart?.sourceTimeUs).toBe(Math.round(2 * 1e6));
    expect(atEnd?.sourceTimeUs).toBe(0);
  });

  it("returns image targets with sourceTimeUs 0", () => {
    const imgs = [
      clip({
        id: "i1",
        startSec: 0,
        endSec: 5,
        assetId: "img-1",
        kind: "image",
      }),
    ];
    expect(resolveFrameTarget(imgs, Math.round(2.5 * 1e6))).toEqual({
      assetId: "img-1",
      sourceTimeUs: 0,
      clipId: "i1",
      kind: "image",
    });
  });
});

describe("resolveSeamPreload", () => {
  const clips: TimelineClip[] = [
    clip({
      id: "c1",
      startSec: 0,
      endSec: 2,
      inSec: 0,
      outSec: 2,
      assetId: "vid-a",
    }),
    clip({
      id: "c2",
      startSec: 2,
      endSec: 4,
      inSec: 5,
      outSec: 7,
      assetId: "vid-b",
    }),
  ];

  it("warms both sides when playhead is near the cut", () => {
    const seam = resolveSeamPreload(clips, 1.9);
    expect(seam.outgoing?.assetId).toBe("vid-a");
    expect(seam.incoming?.assetId).toBe("vid-b");
    expect(seam.incoming?.startTimeUs).toBe(Math.round(5 * 1e6));
  });

  it("peekNextVisualClip finds the incoming clip at a seam", () => {
    expect(peekNextVisualClip(clips, 1.9)?.id).toBe("c2");
  });
});

describe("FrameCache", () => {
  function fakeFrame(timestampUs: number): VideoFrame {
    // Minimal stub — jsdom may not have VideoFrame.
    return {
      timestamp: timestampUs,
      close: vi.fn(),
      clone: vi.fn(),
    } as unknown as VideoFrame;
  }

  it("evicts oldest frames when over capacity and closes them", () => {
    const cache = new FrameCache(3);
    const frames = [0, 1, 2, 3].map((i) => fakeFrame(i * 1000));
    cache.set("a", 0, frames[0]!);
    cache.set("a", 1000, frames[1]!);
    cache.set("a", 2000, frames[2]!);
    cache.set("a", 3000, frames[3]!);
    expect(cache.size).toBe(3);
    expect(frames[0]!.close).toHaveBeenCalled();
  });

  it("findNearest returns a frame within tolerance", () => {
    const cache = new FrameCache(8);
    const frame = fakeFrame(1_000_000);
    cache.set("a", 1_000_000, frame);
    expect(cache.findNearest("a", 1_000_100, 500)?.timestampUs).toBe(1_000_000);
    expect(cache.findNearest("a", 2_000_000, 500)).toBeNull();
  });

  it("releaseAsset closes and drops all frames for an asset", () => {
    const cache = new FrameCache(8);
    const f1 = fakeFrame(0);
    const f2 = fakeFrame(1);
    cache.set("a", 0, f1);
    cache.set("b", 0, f2);
    cache.releaseAsset("a");
    expect(f1.close).toHaveBeenCalled();
    expect(cache.size).toBe(1);
  });
});

describe("preview instrument + stale rejection contract", () => {
  it("notifies subscribers and marks staleRejected", () => {
    const seen: boolean[] = [];
    const unsub = subscribePreviewInstrument((e) => {
      seen.push(e.staleRejected);
    });
    emitPreviewInstrument({
      assetId: "x",
      requestedSourceTimeUs: 0,
      returnedFrameTimeUs: 0,
      keyframeTimeUs: null,
      decodeDurationMs: 1,
      cacheHit: false,
      generation: 1,
      staleRejected: true,
      liveCachedFrames: 0,
    });
    unsub();
    expect(seen).toEqual([true]);
  });

  it("never paints a lower generation over a newer one (scheduler rule)", () => {
    let renderGeneration = 0;
    const painted: number[] = [];
    async function renderAt(genHint: number) {
      const generation = ++renderGeneration;
      // Simulate overlapping requests: older finishes after newer started.
      await Promise.resolve();
      if (generation !== renderGeneration) {
        // stale — do not paint
        return;
      }
      painted.push(genHint);
    }
    void renderAt(1);
    void renderAt(2);
    return Promise.resolve().then(() => {
      expect(painted).toEqual([2]);
    });
  });
});
