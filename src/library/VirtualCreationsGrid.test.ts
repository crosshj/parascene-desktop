import { describe, expect, it } from "vitest";
import { isAppendOnlyIdList, listLostIds } from "./VirtualCreationsGrid";

describe("isAppendOnlyIdList", () => {
  it("allows infinite-scroll appends and rejects reshuffles", () => {
    expect(isAppendOnlyIdList(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(isAppendOnlyIdList(["a", "b"], ["a", "b"])).toBe(true);
    expect(isAppendOnlyIdList([], ["a"])).toBe(true);
    expect(isAppendOnlyIdList(["a", "b"], ["a", "c", "b"])).toBe(false);
    expect(isAppendOnlyIdList(["a", "b", "c"], ["a", "b"])).toBe(false);
  });
});

describe("listLostIds", () => {
  it("detects deletes but not appends or new leading tiles", () => {
    expect(listLostIds(["a", "b", "c"], ["a", "b"])).toBe(true);
    expect(listLostIds(["a", "b"], ["a", "b", "c"])).toBe(false);
    expect(listLostIds(["a", "b"], ["folder", "a", "b"])).toBe(false);
    expect(listLostIds([], ["a"])).toBe(false);
  });
});

describe("board repack trigger", () => {
  it("repacks on delete or a new leading folder, not on append", () => {
    const prev = ["folder:a", "c1"];
    expect(isAppendOnlyIdList(prev, ["folder:a", "c1", "c2"])).toBe(true);
    expect(isAppendOnlyIdList(prev, ["folder:a"])).toBe(false);
    expect(isAppendOnlyIdList(prev, ["folder:tmp", "folder:a", "c1"])).toBe(
      false,
    );
  });
});
