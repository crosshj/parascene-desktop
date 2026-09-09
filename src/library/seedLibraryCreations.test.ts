import { describe, expect, it } from "vitest";
import {
  SEED_LIBRARY_CREATION_IDS,
  isSeedLibraryCreationId,
} from "./seedLibraryCreations";

describe("seedLibraryCreations", () => {
  it("protects the @awesome avatar still", () => {
    expect(SEED_LIBRARY_CREATION_IDS).toContain("28006");
    expect(isSeedLibraryCreationId("28006")).toBe(true);
    expect(isSeedLibraryCreationId(28006)).toBe(true);
    expect(isSeedLibraryCreationId("28425")).toBe(false);
  });
});
