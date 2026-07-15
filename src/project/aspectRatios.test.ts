import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_ASPECT_RATIO,
  isProjectAspectRatio,
  projectAspectCss,
  PROJECT_ASPECT_OPTIONS,
} from "./aspectRatios";

describe("project aspect ratios", () => {
  it("lists the same creative presets as Library aspect filters", () => {
    expect(PROJECT_ASPECT_OPTIONS.map((o) => o.id)).toEqual([
      "1:1",
      "9:16",
      "4:5",
      "16:9",
    ]);
  });

  it("validates and formats ids", () => {
    expect(isProjectAspectRatio("9:16")).toBe(true);
    expect(isProjectAspectRatio("21:9")).toBe(false);
    expect(DEFAULT_PROJECT_ASPECT_RATIO).toBe("16:9");
    expect(projectAspectCss("9:16")).toBe("9 / 16");
    expect(projectAspectCss("1:1")).toBe("1 / 1");
  });
});
