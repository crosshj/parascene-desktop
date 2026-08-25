import { describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../project/types";
import {
  assetDecoderKey,
  assetIdFromKey,
  bufferWindowParkByKey,
  bufferWindowVisualDecoders,
  isReverseKey,
  listVisualDecoders,
  parkSourceByKey,
  visualDecoderMeta,
} from "./assetDecoders";
import { createTimelinePlaybackEngine } from "./timelinePlaybackEngine";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("../library/catalogClient", () => ({
  getCreation: vi.fn(async () => {
    throw new Error("not found");
  }),
  ensureLocal: vi.fn(async () => {}),
}));

vi.mock("../library/reversedMedia", () => ({
  ensureReversedMedia: vi.fn(async () => ({ mediaUrl: "", thumbUrl: null })),
  getCachedReversedMedia: vi.fn(() => null),
  subscribeReversedMediaCache: vi.fn(() => () => {}),
}));

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

describe("assetDecoderKey", () => {
  it("keys forward and reverse video by asset × direction", () => {
    expect(
      assetDecoderKey(
        clip({ id: "c1", startSec: 0, endSec: 4, assetId: "a1", kind: "video" }),
      ),
    ).toBe("a1:f");
    expect(
      assetDecoderKey(
        clip({
          id: "c2",
          startSec: 4,
          endSec: 8,
          assetId: "a1",
          kind: "video",
          reverse: true,
        }),
      ),
    ).toBe("a1:r");
  });

  it("keys slideshow by clip id and bake identity", () => {
    expect(
      assetDecoderKey(
        clip({
          id: "s1",
          startSec: 0,
          endSec: 6,
          kind: "slideshow",
          bakeKey: "bk1",
        }),
      ),
    ).toBe("slideshow:s1:bk1");
  });

  it("keys fresh extend bakes separately from the source asset", () => {
    const extended = clip({
      id: "e1",
      startSec: 0,
      endSec: 20,
      assetId: "a1",
      kind: "video",
      inSec: 0,
      outSec: 5,
      extendBakeKey: JSON.stringify({
        v: 7,
        assetId: "a1",
        inSec: 0,
        outSec: 5,
        pingPong: false,
        reverse: false,
      }),
      extendBakePath: "/tmp/extend.mp4",
      extendBakeCoverSec: 20,
    });
    expect(assetDecoderKey(extended)).toBe(
      `extend:e1:${extended.extendBakeKey}`,
    );
  });
});

describe("key helpers", () => {
  it("parses reverse and asset id from standard keys", () => {
    expect(isReverseKey("a1:r")).toBe(true);
    expect(isReverseKey("a1:f")).toBe(false);
    expect(assetIdFromKey("a1:r")).toBe("a1");
    expect(assetIdFromKey("slideshow:s1:bk")).toBe("");
  });
});

describe("listVisualDecoders", () => {
  it("dedupes the same asset×direction across clips", () => {
    const clips = [
      clip({ id: "c1", startSec: 0, endSec: 3, assetId: "a1" }),
      clip({ id: "c2", startSec: 3, endSec: 6, assetId: "a1" }),
      clip({ id: "c3", startSec: 6, endSec: 9, assetId: "a2", reverse: true }),
      clip({
        id: "a",
        startSec: 0,
        endSec: 9,
        assetId: "song",
        lane: "audio",
        kind: "audio",
      }),
    ];
    const keys = listVisualDecoders(clips).map((d) => d.key);
    expect(keys).toEqual(["a1:f", "a2:r"]);
  });
});

describe("visualDecoderMeta", () => {
  it("parks ordinary video at the clip in-point", () => {
    expect(
      visualDecoderMeta(
        clip({
          id: "c1",
          startSec: 0,
          endSec: 4,
          assetId: "a1",
          inSec: 3.25,
          outSec: 7,
        }),
      )?.parkStartSec,
    ).toBe(3.25);
  });
});

describe("bufferWindowVisualDecoders", () => {
  const clips = [
    clip({ id: "c1", startSec: 0, endSec: 4, assetId: "a1" }),
    clip({ id: "c2", startSec: 4, endSec: 8, assetId: "a2" }),
    clip({ id: "c3", startSec: 8, endSec: 12, assetId: "a3" }),
    clip({ id: "c4", startSec: 12, endSec: 16, assetId: "a4" }),
  ];

  it("keeps previous, current, and next around the playhead", () => {
    expect(
      bufferWindowVisualDecoders(clips, 0).map((d) => d.key),
    ).toEqual(["a1:f", "a2:f"]);
    expect(
      bufferWindowVisualDecoders(clips, 5).map((d) => d.key).sort(),
    ).toEqual(["a1:f", "a2:f", "a3:f"]);
    expect(
      bufferWindowVisualDecoders(clips, 13).map((d) => d.key).sort(),
    ).toEqual(["a3:f", "a4:f"]);
  });

  it("dedupes when prev and next share an asset", () => {
    const reuse = [
      clip({ id: "c1", startSec: 0, endSec: 4, assetId: "a1" }),
      clip({ id: "c2", startSec: 4, endSec: 8, assetId: "a2" }),
      clip({ id: "c3", startSec: 8, endSec: 12, assetId: "a1" }),
    ];
    expect(
      bufferWindowVisualDecoders(reuse, 5).map((d) => d.key).sort(),
    ).toEqual(["a1:f", "a2:f"]);
  });
});

describe("bufferWindowParkByKey", () => {
  it("parks the upcoming clip at its in-point and the previous at last frame", () => {
    const clips = [
      clip({
        id: "c1",
        startSec: 0,
        endSec: 4,
        assetId: "a1",
        inSec: 2,
        outSec: 6,
      }),
      clip({
        id: "c2",
        startSec: 4,
        endSec: 8,
        assetId: "a2",
        inSec: 10,
        outSec: 14,
      }),
      clip({
        id: "c3",
        startSec: 8,
        endSec: 12,
        assetId: "a3",
        inSec: 1.5,
        outSec: 5,
      }),
    ];
    const park = bufferWindowParkByKey(clips, 5);
    expect(park.get("a3:f")).toBe(1.5);
    expect(park.get("a1:f")).toBeCloseTo(6 - 1 / 60, 5);
  });

  it("parks extend bakes at bake time 0, not the original in-point", () => {
    const bakeKey = JSON.stringify({
      v: 7,
      assetId: "a1",
      inSec: 2,
      outSec: 7,
      pingPong: false,
      reverse: false,
    });
    const clips = [
      clip({ id: "c1", startSec: 0, endSec: 4, assetId: "a0" }),
      clip({
        id: "e1",
        startSec: 4,
        endSec: 24,
        assetId: "a1",
        inSec: 2,
        outSec: 7,
        extendBakeKey: bakeKey,
        extendBakePath: "/tmp/extend.mp4",
        extendBakeCoverSec: 20,
      }),
    ];
    const park = bufferWindowParkByKey(clips, 1);
    const extendKey = [...park.keys()].find((k) => k.startsWith("extend:"));
    expect(extendKey).toBeTruthy();
    expect(park.get(extendKey!)).toBe(0);
  });
});

describe("parkSourceByKey", () => {
  it("parks each decoder on the earliest in-point for that key", () => {
    const clips = [
      clip({
        id: "c1",
        startSec: 0,
        endSec: 4,
        assetId: "a1",
        inSec: 2,
        outSec: 6,
      }),
      clip({
        id: "c2",
        startSec: 4,
        endSec: 8,
        assetId: "a1",
        inSec: 10,
        outSec: 14,
      }),
      clip({
        id: "c3",
        startSec: 8,
        endSec: 12,
        assetId: "a2",
        inSec: 1.5,
        outSec: 5,
        reverse: true,
      }),
    ];
    const park = parkSourceByKey(clips);
    expect(park.get("a1:f")).toBe(2);
    expect(park.get("a2:r")).toBe(1.5);
  });

  it("parks slideshow decoders at 0", () => {
    const clips = [
      clip({
        id: "s1",
        startSec: 0,
        endSec: 5,
        kind: "slideshow",
        bakePath: "/tmp/s.mp4",
      }),
    ];
    expect(parkSourceByKey(clips).get("slideshow:s1:/tmp/s.mp4")).toBe(0);
  });

  it("parks extend bake decoders at 0", () => {
    const bakeKey = JSON.stringify({
      v: 7,
      assetId: "a1",
      inSec: 2,
      outSec: 7,
      pingPong: false,
      reverse: false,
    });
    const clips = [
      clip({
        id: "e1",
        startSec: 0,
        endSec: 20,
        assetId: "a1",
        inSec: 2,
        outSec: 7,
        extendBakeKey: bakeKey,
        extendBakePath: "/tmp/extend.mp4",
        extendBakeCoverSec: 20,
      }),
    ];
    expect(parkSourceByKey(clips).get(`extend:e1:${bakeKey}`)).toBe(0);
  });
});

describe("createTimelinePlaybackEngine", () => {
  it("creates a surface, tracks clips/time, and destroys cleanly", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const times: number[] = [];
    const playingChanges: boolean[] = [];

    const engine = createTimelinePlaybackEngine(host, {
      stageW: 960,
      stageH: 540,
      matteW: 960,
      matteH: 540,
      onTimeUpdate: (sec) => times.push(sec),
      onPlayingChange: (p) => playingChanges.push(p),
    });

    expect(host.querySelector(".timeline-playback-engine")).toBeTruthy();

    engine.setClips([
      clip({ id: "c1", startSec: 0, endSec: 4, assetId: "a1" }),
      clip({ id: "c2", startSec: 4, endSec: 8, assetId: "a2" }),
    ]);
    engine.seek(2.5);
    expect(engine.getCurrentTime()).toBe(2.5);
    expect(times).toEqual([2.5]);

    engine.play();
    expect(engine.isPlaying()).toBe(true);
    engine.pause();
    expect(engine.isPlaying()).toBe(false);
    expect(playingChanges).toEqual([true, false]);

    engine.destroy();
    expect(host.querySelector(".timeline-playback-engine")).toBeNull();
    engine.seek(9);
    expect(engine.getCurrentTime()).toBe(2.5);
    host.remove();
  });
});
