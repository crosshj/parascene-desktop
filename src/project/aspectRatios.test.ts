import { describe, expect, it } from "vitest";
import {
  aspectChooserOptionsFromSupported,
  DEFAULT_PROJECT_ASPECT_RATIO,
  isProjectAspectRatio,
  pickAspectChooserValue,
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

  it("builds mini chooser options from model-supported enums only", () => {
    expect(
      aspectChooserOptionsFromSupported(["16:9", "9:16", "21:9"]).map(
        (o) => o.id,
      ),
    ).toEqual(["9:16", "16:9"]);
    expect(
      aspectChooserOptionsFromSupported([
        "9:16",
        "1:1",
        "16:9",
        "4:5",
      ]).map((o) => o.id),
    ).toEqual(["1:1", "4:5", "9:16", "16:9"]);
    expect(aspectChooserOptionsFromSupported(["21:9", "3:2"])).toEqual([]);
    expect(aspectChooserOptionsFromSupported(null)).toEqual([]);
  });

  it("picks a chooser value from preferred / default / first", () => {
    const opts = aspectChooserOptionsFromSupported(["9:16", "1:1"]);
    expect(pickAspectChooserValue(opts, "9:16")).toBe("9:16");
    expect(pickAspectChooserValue(opts, "21:9")).toBe("1:1");
    const withCinema = aspectChooserOptionsFromSupported(["9:16", "16:9"]);
    expect(pickAspectChooserValue(withCinema, "21:9")).toBe("16:9");
  });
});
