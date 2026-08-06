import { describe, expect, it } from "vitest";
import {
  normalizeProjectTitle,
  PROJECT_TITLE_MAX_GRAPHEMES,
} from "./projectTitle";

describe("normalizeProjectTitle", () => {
  it("defaults empty titles and truncates at grapheme boundaries", () => {
    expect(normalizeProjectTitle("   ")).toBe("Untitled project");
    const family = "👨‍👩‍👧‍👦";
    const normalized = normalizeProjectTitle(
      family.repeat(PROJECT_TITLE_MAX_GRAPHEMES + 1),
    );
    expect(normalized).toBe(family.repeat(PROJECT_TITLE_MAX_GRAPHEMES));
  });
});
