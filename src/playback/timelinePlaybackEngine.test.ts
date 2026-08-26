import { describe, expect, it, vi } from "vitest";
import type { TimelineFragmentCache } from "../layouts/editor/timelineFragmentCache";
import { createTimelinePlaybackEngine } from "./timelinePlaybackEngine";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("./mseFragmentPlayer", async () => {
  const actual = await vi.importActual<typeof import("./mseFragmentPlayer")>(
    "./mseFragmentPlayer",
  );
  return {
    ...actual,
    timelineMseSupported: () => true,
  };
});

function mockFragmentCache(): TimelineFragmentCache {
  return {
    fragmentCovering: () => null,
    readyFragments: () => [],
    hasContinuity: () => false,
    isWindowReady: () => false,
    videoExtentSec: () => 4,
    status: () => ({
      ready: 0,
      total: 2,
      baking: true,
      queued: 0,
      error: null,
      playheadReady: false,
      depwait: false,
    }),
    isDepwaitAt: () => false,
    invalidateFragmentAtPath: () => {},
    reportError: () => {},
    subscribe: () => () => {},
    refresh: () => {},
    destroy: () => {},
    setClips: () => {},
    setPlayhead: () => {},
    demandPlayableWindow: () => {},
    setAspectRatio: () => {},
    setPreviewQuality: () => {},
    setTimeline: () => {},
  } as TimelineFragmentCache;
}

describe("createTimelinePlaybackEngine admission policy", () => {
  it("does not export fail-open timeout constant", async () => {
    const mod = await import("./timelinePlaybackEngine");
    expect("PREVIEW_BUFFERING_FAIL_OPEN_MS" in mod).toBe(false);
  });

  it("holds play when preview window is not verified", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const onPreviewStatusChange = vi.fn();
    const engine = createTimelinePlaybackEngine(host, {
      stageW: 960,
      stageH: 540,
      matteW: 960,
      matteH: 540,
      onPreviewStatusChange,
    });
    engine.setClips([
      {
        id: "v1",
        lane: "video",
        label: "v1",
        startSec: 0,
        endSec: 4,
        assetId: "a1",
        kind: "video",
      },
    ]);
    engine.setFragmentCache(mockFragmentCache());
    engine.play();
    expect(engine.isBuffering()).toBe(true);
    const calls = onPreviewStatusChange.mock.calls;
    const last = calls[calls.length - 1]?.[0];
    expect(last?.holding).toBe(true);
    expect(last?.phase === "loading" || last?.phase === "baking").toBe(true);
    engine.destroy();
    host.remove();
  });

  it("exposes retryPreview for blocked recovery", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const engine = createTimelinePlaybackEngine(host, {
      stageW: 960,
      stageH: 540,
      matteW: 960,
      matteH: 540,
    });
    expect(typeof engine.retryPreview).toBe("function");
    engine.destroy();
    host.remove();
  });

  it("reports depwait when fragment cache waits on local media", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const onPreviewStatusChange = vi.fn();
    const engine = createTimelinePlaybackEngine(host, {
      stageW: 960,
      stageH: 540,
      matteW: 960,
      matteH: 540,
      onPreviewStatusChange,
    });
    engine.setClips([
      {
        id: "v1",
        lane: "video",
        label: "v1",
        startSec: 0,
        endSec: 4,
        assetId: "a1",
        kind: "video",
      },
    ]);
    engine.setFragmentCache({
      ...mockFragmentCache(),
      isDepwaitAt: () => true,
      status: () => ({
        ready: 0,
        total: 2,
        baking: false,
        queued: 0,
        error: null,
        playheadReady: false,
        depwait: true,
      }),
    });
    engine.play();
    const calls = onPreviewStatusChange.mock.calls;
    const last = calls[calls.length - 1]?.[0];
    expect(last?.phase).toBe("depwait");
    expect(last?.holding).toBe(true);
    engine.destroy();
    host.remove();
  });
});
