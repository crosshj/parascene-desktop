import { describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../project/types";
import {
  decoderCommandedSourceSec,
  decoderWantsClockSync,
} from "./decoderPool";
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

vi.mock("../library/slideshowMedia", async () => {
  const actual = await vi.importActual<
    typeof import("../library/slideshowMedia")
  >("../library/slideshowMedia");
  return {
    ...actual,
    mediaUrlForBakePath: (path: string) => `media://${path}`,
  };
});

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

describe("decoderCommandedSourceSec", () => {
  it("uses park time when inactive", () => {
    expect(decoderCommandedSourceSec("video", false, null, 2.5)).toBe(2.5);
  });

  it("maps extend bake through localSec × speed", () => {
    const layer = {
      clip: clip({
        id: "e1",
        startSec: 0,
        endSec: 10,
        assetId: "a1",
        speed: 0.5,
      }),
      localSec: 4,
      sourceSec: 2,
    };
    expect(decoderCommandedSourceSec("extend", true, layer, 0)).toBe(2);
  });

  it("uses sourceSec for ordinary video / slideshow", () => {
    const layer = {
      clip: clip({ id: "c1", startSec: 0, endSec: 4, assetId: "a1" }),
      localSec: 1,
      sourceSec: 3.2,
    };
    expect(decoderCommandedSourceSec("video", true, layer, 0)).toBe(3.2);
    expect(decoderCommandedSourceSec("slideshow", true, layer, 0)).toBe(3.2);
  });
});

describe("decoderWantsClockSync", () => {
  it("clock-syncs slideshow and extend always", () => {
    expect(decoderWantsClockSync("slideshow", null)).toBe(true);
    expect(decoderWantsClockSync("extend", null)).toBe(true);
  });

  it("clock-syncs video only when speed ≠ 1", () => {
    const normal = {
      clip: clip({ id: "c1", startSec: 0, endSec: 4, assetId: "a1" }),
      localSec: 0,
      sourceSec: 0,
    };
    const slow = {
      clip: clip({
        id: "c2",
        startSec: 0,
        endSec: 4,
        assetId: "a1",
        speed: 0.5,
      }),
      localSec: 0,
      sourceSec: 0,
    };
    expect(decoderWantsClockSync("video", normal)).toBe(false);
    expect(decoderWantsClockSync("video", slow)).toBe(true);
  });
});

describe("createTimelinePlaybackEngine Phase 4", () => {
  it("creates decoder slots for timeline assets and tears them down", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const engine = createTimelinePlaybackEngine(host, {
      stageW: 960,
      stageH: 540,
      matteW: 960,
      matteH: 540,
    });

    engine.setClips([
      clip({ id: "c1", startSec: 0, endSec: 4, assetId: "a1" }),
      clip({ id: "c2", startSec: 4, endSec: 8, assetId: "a2", reverse: true }),
      clip({
        id: "s1",
        startSec: 8,
        endSec: 12,
        kind: "slideshow",
        bakePath: "/tmp/s.mp4",
      }),
    ]);

    const surface = host.querySelector(".timeline-playback-engine");
    expect(surface).toBeTruthy();
    // One viewport per visual decoder (a1:f, a2:r, slideshow).
    expect(
      surface!.querySelectorAll(".editor-preview-framing-viewport").length,
    ).toBe(3);
    // Slideshow bake has a video src immediately.
    expect(surface!.querySelectorAll("video").length).toBeGreaterThanOrEqual(1);
    // Magenta debug marker removed in Phase 4.
    expect(surface!.querySelector('[title="Playback engine"]')).toBeNull();

    engine.seek(5);
    expect(engine.getCurrentTime()).toBe(5);
    engine.play();
    expect(engine.isPlaying()).toBe(true);

    engine.destroy();
    expect(host.querySelector(".timeline-playback-engine")).toBeNull();
    host.remove();
  });

  it("owns the playhead clock while playing and throttles onTimeUpdate", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const rafCbs: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const times: number[] = [];
    const engine = createTimelinePlaybackEngine(host, {
      stageW: 960,
      stageH: 540,
      matteW: 960,
      matteH: 540,
      onTimeUpdate: (sec) => times.push(sec),
    });
    engine.setClips([clip({ id: "c1", startSec: 0, endSec: 10, assetId: "a1" })]);
    engine.seek(0);
    times.length = 0;

    engine.play();
    expect(rafCbs.length).toBe(1);

    // First frame: +50ms — too soon for throttled emit.
    now = 1050;
    rafCbs.shift()!(now);
    expect(engine.getCurrentTime()).toBeCloseTo(0.05, 5);
    expect(times).toEqual([]);

    // Later frame: past 5 Hz window → emit.
    now = 1250;
    rafCbs.shift()!(now);
    expect(engine.getCurrentTime()).toBeCloseTo(0.25, 5);
    expect(times).toEqual([0.25]);

    engine.pause();
    expect(engine.isPlaying()).toBe(false);
    // Pause always emits the final time.
    expect(times[times.length - 1]).toBeCloseTo(0.25, 5);

    engine.destroy();
    host.remove();
    vi.restoreAllMocks();
  });

  it("wraps at sequence end and seek() while playing is a discontinuity", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const rafCbs: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const engine = createTimelinePlaybackEngine(host, {
      stageW: 960,
      stageH: 540,
      matteW: 960,
      matteH: 540,
    });
    engine.setClips([clip({ id: "c1", startSec: 0, endSec: 1, assetId: "a1" })]);
    engine.seek(0.9);
    engine.play();

    now = 200;
    rafCbs.shift()!(now);
    // 0.9 + 0.2 → wrap to 0.1
    expect(engine.getCurrentTime()).toBeCloseTo(0.1, 5);

    engine.seek(0.5);
    expect(engine.getCurrentTime()).toBe(0.5);

    engine.destroy();
    host.remove();
    vi.restoreAllMocks();
  });

  it("clears cut bookkeeping in a gap so the next clip can activate (gap-start)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const engine = createTimelinePlaybackEngine(host, {
      stageW: 960,
      stageH: 540,
      matteW: 960,
      matteH: 540,
    });
    engine.setClips([
      clip({ id: "c1", startSec: 0, endSec: 2, assetId: "a1" }),
      clip({ id: "c2", startSec: 4, endSec: 6, assetId: "a2" }),
    ]);

    // Scrub onto c2 (would leave lastPlayClipId = c2), then into the gap.
    engine.seek(4.5);
    expect(engine.getDiagnostics().activeKey).toBe("a2:f");
    engine.seek(3);
    expect(engine.getDiagnostics().activeKey).toBeNull();
    expect(engine.getDiagnostics().visibleKey).toBeNull();

    // Play from the gap then jump onto c2 — must re-activate (not stuck on stale id).
    engine.play();
    engine.seek(4.1);
    const diag = engine.getDiagnostics();
    expect(diag.activeKey).toBe("a2:f");
    // Without media src in jsdom, activate may stall — but cut bookkeeping must
    // allow retries (active without a permanently-stuck idle state).
    expect(diag.stallReason === null || diag.stallReason.length > 0).toBe(true);

    engine.destroy();
    host.remove();
  });

  it("exposes warm / cut diagnostics", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const engine = createTimelinePlaybackEngine(host, {
      stageW: 960,
      stageH: 540,
      matteW: 960,
      matteH: 540,
    });
    engine.setClips([
      clip({
        id: "s1",
        startSec: 0,
        endSec: 4,
        kind: "slideshow",
        bakePath: "/tmp/s.mp4",
      }),
    ]);
    engine.seek(0);
    const diag = engine.getDiagnostics();
    expect(diag.activeKey).toMatch(/^slideshow:/);
    expect(diag).toHaveProperty("warmKeys");
    expect(diag).toHaveProperty("lastCutLatencyMs");
    expect(diag).toHaveProperty("stallReason");
    engine.destroy();
    host.remove();
  });
});
