import { describe, expect, it } from "vitest";
import { filedIdSet, omitFiledCreations } from "./folderClient";

describe("omitFiledCreations", () => {
  it("hides creations that belong to a folder", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const filed = filedIdSet(["b"]);
    expect(omitFiledCreations(rows, filed).map((r) => r.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("returns all when nothing is filed", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(omitFiledCreations(rows, new Set()).map((r) => r.id)).toEqual([
      "a",
      "b",
    ]);
  });
});
