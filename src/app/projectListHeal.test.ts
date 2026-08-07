import { describe, expect, it } from "vitest";
import { shouldHealStoredProjectsFromStorage } from "./projectListHeal";

describe("shouldHealStoredProjectsFromStorage", () => {
  it("heals when memory is empty but storage has projects", () => {
    expect(shouldHealStoredProjectsFromStorage([], ["a", "b"])).toBe(true);
  });

  it("heals when storage has a project missing from memory", () => {
    expect(
      shouldHealStoredProjectsFromStorage(["a", "b"], ["a", "b", "melting"]),
    ).toBe(true);
  });

  it("does not heal when memory already includes every storage id", () => {
    expect(
      shouldHealStoredProjectsFromStorage(["b", "a"], ["a", "b"]),
    ).toBe(false);
  });

  it("does not heal when storage is empty", () => {
    expect(shouldHealStoredProjectsFromStorage(["a"], [])).toBe(false);
  });
});
