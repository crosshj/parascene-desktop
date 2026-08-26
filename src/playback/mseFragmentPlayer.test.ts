import { describe, expect, it, vi } from "vitest";
import {
  createMseFragmentPlayer,
  timelineMseSupported,
} from "./mseFragmentPlayer";

describe("createMseFragmentPlayer", () => {
  it("mounts a single muted video element and tears it down", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    expect(host.querySelector("video")).toBeNull();
    player.show();
    expect(host.querySelector("video")).toBe(player.video);
    expect(player.video.muted).toBe(true);
    expect(player.isActive()).toBe(true);
    player.hide();
    expect(player.isActive()).toBe(false);
    expect(player.covers(0)).toBe(false);
    player.warm();
    expect(player.isActive()).toBe(false);
    expect(host.querySelector("video")).toBe(player.video);
    player.destroy();
    expect(host.querySelector("video")).toBeNull();
    host.remove();
  });

  it("reports MSE support without throwing", () => {
    expect(typeof timelineMseSupported()).toBe("boolean");
  });

  it("calls muted play() when the timeline is running", () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    player.show();
    player.sync(0.5, true, [], { feed: false, seek: false });
    expect(play).toHaveBeenCalled();
    player.destroy();
    host.remove();
    play.mockRestore();
  });

  it("keeps a seek pending until the target range is buffered", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    player.show();
    player.sync(1.2, false, [], { feed: false, seek: true });
    expect(player.hasPendingSeek()).toBe(true);
    expect(player.getTime()).toBe(0);
    player.destroy();
    host.remove();
  });

  it("reports exact range coverage, not interior slop", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    player.show();
    expect(player.coversRangeExact(0, 2)).toBe(false);
    expect(player.appendedCount()).toBe(0);
    player.destroy();
    host.remove();
  });

  it("does not roll from a stale position while a seek waits for data", () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    player.show();
    player.sync(3, true, [], { feed: false, seek: true });
    expect(player.hasPendingSeek()).toBe(true);
    expect(play).not.toHaveBeenCalled();
    player.destroy();
    host.remove();
    play.mockRestore();
  });

  it("reports fragment fetch failures instead of swallowing them", async () => {
    const onFetchError = vi.fn();
    const fetchMock = vi.fn().mockRejectedValue(new Error("CSP blocked"));
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host, { onFetchError });
    player.show();
    player.sync(
      0,
      false,
      [
        {
          index: 0,
          startSec: 0,
          durationSec: 2,
          fingerprint: "abc",
          path: "/tmp/frag.mp4",
        },
      ],
      { feed: true },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(onFetchError).toHaveBeenCalled();
    expect(String(onFetchError.mock.calls[0]?.[0]).length).toBeGreaterThan(0);
    player.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });

  it("discards stale generation work", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    player.warm();
    player.setGeneration(1);
    player.setGeneration(2);
    expect(player.getPreviewPhase()).not.toBe("blocked");
    player.destroy();
    host.remove();
  });
});
