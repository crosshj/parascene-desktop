import { describe, expect, it } from "vitest";
import {
  assertReplicateLocalFiles,
  summarizeLocalFilesForTrace,
} from "./addAssetReplicateGenerate";

describe("assertReplicateLocalFiles", () => {
  it("passes when required fields have non-empty paths", () => {
    expect(() =>
      assertReplicateLocalFiles(
        { start_image: "/tmp/still.jpg", end_image: "/tmp/end.jpg" },
        ["start_image", "end_image"],
      ),
    ).not.toThrow();
  });

  it("throws when a required field is missing or empty", () => {
    expect(() =>
      assertReplicateLocalFiles({ start_image: "  " }, ["start_image"]),
    ).toThrow(/Missing local file for Replicate input “start_image”/);
    expect(() => assertReplicateLocalFiles({}, ["start_image"])).toThrow(
      /start_image/,
    );
  });
});

describe("summarizeLocalFilesForTrace", () => {
  it("summarizes basenames only", () => {
    expect(
      summarizeLocalFilesForTrace({
        start_image: "/Users/me/Library/media/17995.png",
        end_image: "C:\\Cache\\framed-stills\\abc-fit-16x9-v2.jpg",
      }),
    ).toBe(
      "end_image=abc-fit-16x9-v2.jpg,start_image=17995.png",
    );
  });

  it("handles empty map", () => {
    expect(summarizeLocalFilesForTrace({})).toBe("(none)");
  });
});
