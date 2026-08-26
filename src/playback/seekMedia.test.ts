import { describe, expect, it } from "vitest";
import { mediaAtSec, seekMedia, waitForMetadata } from "./seekMedia";

describe("mediaAtSec", () => {
  it("treats a paused element at the target as already aligned", () => {
    const el = document.createElement("video");
    el.currentTime = 2.5;
    expect(mediaAtSec(el, 2.5)).toBe(true);
    expect(mediaAtSec(el, 2.56)).toBe(false);
    expect(mediaAtSec(el, 2.51)).toBe(true);
  });
});

describe("waitForMetadata / seekMedia", () => {
  it("does not wait when there is no src", async () => {
    const el = document.createElement("video");
    await waitForMetadata(el);
  });

  it("skips the seek when already at the target", async () => {
    const el = document.createElement("video");
    el.currentTime = 1.2;
    expect(await seekMedia(el, 1.2)).toBe(false);
  });
});
