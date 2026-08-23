import { describe, expect, it } from "vitest";
import { generationErrorPresentation } from "./generationErrorPresentation";

describe("generationErrorPresentation", () => {
  it("returns null for empty messages", () => {
    expect(generationErrorPresentation(null)).toBeNull();
    expect(generationErrorPresentation("   ")).toBeNull();
  });

  it("uses a friendly summary for short single-line errors", () => {
    expect(
      generationErrorPresentation("HTTP 402: insufficient credits"),
    ).toEqual({
      summary: "Generation failed.",
      details: "HTTP 402: insufficient credits",
    });
  });

  it("uses the first line as summary for multi-line errors", () => {
    expect(
      generationErrorPresentation("Create failed\nServer returned 500"),
    ).toEqual({
      summary: "Create failed",
      details: "Create failed\nServer returned 500",
    });
  });
});
