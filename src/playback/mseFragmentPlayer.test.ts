import { describe, expect, it } from "vitest";
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
});
