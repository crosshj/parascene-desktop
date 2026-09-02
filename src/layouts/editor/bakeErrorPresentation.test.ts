import { describe, expect, it } from "vitest";
import { bakeErrorPresentation } from "./bakeErrorPresentation";

describe("bakeErrorPresentation", () => {
  it("returns null for empty messages", () => {
    expect(bakeErrorPresentation(null)).toBeNull();
    expect(bakeErrorPresentation("   ")).toBeNull();
  });

  it("hides a jammed ffmpeg version banner behind a short summary", () => {
    const dump =
      "ffmpeg failed (exit status: 183): ffmpeg version 7.1.1-tessus https://evermeet.cx/ffmpeg/ Copyright (c) 2000-2024 the FFmpeg developers built with Apple clang version 16.0.0";
    expect(bakeErrorPresentation(dump)).toEqual({
      summary: "FFmpeg could not bake this clip.",
      details: dump,
    });
  });

  it("keeps a real encode line as the summary", () => {
    expect(
      bakeErrorPresentation("ffmpeg failed (exit 1): width not divisible by 2 (853x480)"),
    ).toEqual({
      summary: "ffmpeg failed (exit 1): width not divisible by 2 (853x480)",
      details: "ffmpeg failed (exit 1): width not divisible by 2 (853x480)",
    });
  });
});
