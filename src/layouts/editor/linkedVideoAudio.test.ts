import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import {
  expandLinkedMoveIds,
  findLinkedAudioForVideo,
  isLinkedVideoAudioClip,
  removeClipsWithLinkedAudio,
  syncLinkedVideoAudio,
  videoElementCarriesMonitorAudio,
  videoWantsLinkedAudio,
} from "./linkedVideoAudio";

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

describe("syncLinkedVideoAudio", () => {
  it("creates a Master Audio companion when Include Audio is on", () => {
    const timeline = [
      clip({
        id: "v1",
        startSec: 2,
        endSec: 8,
        kind: "video",
        assetId: "asset-v",
        includeAudio: true,
        inSec: 1,
        outSec: 7,
        reverse: true,
      }),
      clip({
        id: "bed",
        startSec: 0,
        endSec: 20,
        lane: "audio",
        kind: "audio",
        assetId: "song",
      }),
    ];
    const next = syncLinkedVideoAudio(timeline);
    const companion = findLinkedAudioForVideo(next, "v1");
    expect(companion).toMatchObject({
      lane: "audio",
      kind: "audio",
      linkedVideoClipId: "v1",
      assetId: "asset-v",
      startSec: 2,
      endSec: 8,
      inSec: 1,
      outSec: 7,
      reverse: true,
    });
    expect(next.filter((c) => c.lane === "audio")).toHaveLength(2);
  });

  it("mirrors speed and extend fields onto the companion", () => {
    const next = syncLinkedVideoAudio([
      clip({
        id: "v1",
        startSec: 0,
        endSec: 12,
        kind: "video",
        assetId: "asset-v",
        includeAudio: true,
        inSec: 0,
        outSec: 4,
        speed: 2,
        extendPingPong: true,
        extendSourceSpanSec: 4,
      }),
    ]);
    expect(findLinkedAudioForVideo(next, "v1")).toMatchObject({
      speed: 2,
      extendPingPong: true,
      extendSourceSpanSec: 4,
      endSec: 12,
      outSec: 4,
    });
  });

  it("removes the companion when Include Audio is turned off", () => {
    const withCompanion = syncLinkedVideoAudio([
      clip({
        id: "v1",
        startSec: 0,
        endSec: 4,
        kind: "video",
        assetId: "a",
        includeAudio: true,
      }),
    ]);
    expect(findLinkedAudioForVideo(withCompanion, "v1")).toBeTruthy();
    const off = withCompanion.map((c) =>
      c.id === "v1" ? { ...c, includeAudio: false } : c,
    );
    const next = syncLinkedVideoAudio(off);
    expect(findLinkedAudioForVideo(next, "v1")).toBeUndefined();
    expect(next).toHaveLength(1);
  });

  it("keeps companion timing synced to the video", () => {
    let timeline = syncLinkedVideoAudio([
      clip({
        id: "v1",
        startSec: 0,
        endSec: 5,
        kind: "video",
        assetId: "a",
        includeAudio: true,
      }),
    ]);
    timeline = timeline.map((c) =>
      c.id === "v1" ? { ...c, startSec: 3, endSec: 9, outSec: 6 } : c,
    );
    const next = syncLinkedVideoAudio(timeline);
    expect(findLinkedAudioForVideo(next, "v1")).toMatchObject({
      startSec: 3,
      endSec: 9,
      outSec: 6,
    });
  });
});

describe("expandLinkedMoveIds", () => {
  it("glues video and companion for group moves", () => {
    const timeline = syncLinkedVideoAudio([
      clip({
        id: "v1",
        startSec: 0,
        endSec: 4,
        kind: "video",
        assetId: "a",
        includeAudio: true,
      }),
    ]);
    const companionId = findLinkedAudioForVideo(timeline, "v1")!.id;
    expect(expandLinkedMoveIds(timeline, ["v1"]).sort()).toEqual(
      ["v1", companionId].sort(),
    );
    expect(expandLinkedMoveIds(timeline, [companionId]).sort()).toEqual(
      ["v1", companionId].sort(),
    );
  });
});

describe("removeClipsWithLinkedAudio", () => {
  it("deletes the companion with the video", () => {
    const timeline = syncLinkedVideoAudio([
      clip({
        id: "v1",
        startSec: 0,
        endSec: 4,
        kind: "video",
        assetId: "a",
        includeAudio: true,
      }),
      clip({
        id: "bed",
        startSec: 0,
        endSec: 10,
        lane: "audio",
        kind: "audio",
        assetId: "song",
      }),
    ]);
    const next = removeClipsWithLinkedAudio(timeline, new Set(["v1"]));
    expect(next.map((c) => c.id)).toEqual(["bed"]);
  });

  it("turns Include Audio off when only the companion is removed", () => {
    const timeline = syncLinkedVideoAudio([
      clip({
        id: "v1",
        startSec: 0,
        endSec: 4,
        kind: "video",
        assetId: "a",
        includeAudio: true,
      }),
    ]);
    const companionId = findLinkedAudioForVideo(timeline, "v1")!.id;
    const next = removeClipsWithLinkedAudio(timeline, new Set([companionId]));
    expect(next).toHaveLength(1);
    expect(next[0]?.includeAudio).toBe(false);
    expect(findLinkedAudioForVideo(next, "v1")).toBeUndefined();
  });
});

describe("helpers", () => {
  it("detects linked companions and include-audio videos", () => {
    expect(
      isLinkedVideoAudioClip(
        clip({
          id: "a",
          startSec: 0,
          endSec: 1,
          lane: "audio",
          kind: "audio",
          linkedVideoClipId: "v1",
        }),
      ),
    ).toBe(true);
    expect(
      videoWantsLinkedAudio(
        clip({
          id: "v",
          startSec: 0,
          endSec: 1,
          kind: "video",
          assetId: "x",
          includeAudio: true,
        }),
      ),
    ).toBe(true);
    expect(
      videoWantsLinkedAudio(
        clip({
          id: "v",
          startSec: 0,
          endSec: 1,
          kind: "video",
          assetId: "x",
          includeAudio: false,
        }),
      ),
    ).toBe(false);
  });
});

describe("videoElementCarriesMonitorAudio", () => {
  const visual = clip({
    id: "v1",
    startSec: 0,
    endSec: 4,
    kind: "video",
    assetId: "take",
    includeAudio: true,
  });

  it("uses the video buffer when A1 is the linked companion", () => {
    expect(
      videoElementCarriesMonitorAudio(
        visual,
        clip({
          id: "linked",
          startSec: 0,
          endSec: 4,
          lane: "audio",
          kind: "audio",
          assetId: "take",
          linkedVideoClipId: "v1",
        }),
      ),
    ).toBe(true);
  });

  it("uses the video buffer when A1 is empty and Include Audio is on", () => {
    expect(videoElementCarriesMonitorAudio(visual, null)).toBe(true);
  });

  it("stays silent when A1 is empty and Include Audio is off", () => {
    expect(
      videoElementCarriesMonitorAudio(
        { ...visual, includeAudio: false },
        null,
      ),
    ).toBe(false);
  });

  it("leaves A1 beds on the audio element (video stays muted)", () => {
    expect(
      videoElementCarriesMonitorAudio(
        { ...visual, includeAudio: false },
        clip({
          id: "bed",
          startSec: 0,
          endSec: 10,
          lane: "audio",
          kind: "audio",
          assetId: "song",
        }),
      ),
    ).toBe(false);
  });

  it("uses the video buffer for off-speed Include Audio", () => {
    expect(
      videoElementCarriesMonitorAudio({ ...visual, speed: 0.5 }, null),
    ).toBe(true);
  });

  it("does not use the video element for slideshow visuals", () => {
    expect(
      videoElementCarriesMonitorAudio(
        clip({
          id: "s1",
          startSec: 0,
          endSec: 4,
          kind: "slideshow",
          includeAudio: true,
        }),
        null,
      ),
    ).toBe(false);
  });
});
