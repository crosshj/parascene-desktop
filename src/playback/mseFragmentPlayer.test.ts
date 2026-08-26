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
    // Nothing buffered in jsdom — the seek must wait, not vanish.
    expect(player.hasPendingSeek()).toBe(true);
    expect(player.getTime()).toBe(0);
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
});
