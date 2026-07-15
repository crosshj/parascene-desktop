import { describe, expect, it } from "vitest";
import { isAppendOnlyIdList } from "./VirtualCreationsGrid";

describe("isAppendOnlyIdList", () => {
  it("allows infinite-scroll appends and rejects reshuffles", () => {
    expect(isAppendOnlyIdList(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(isAppendOnlyIdList(["a", "b"], ["a", "b"])).toBe(true);
    expect(isAppendOnlyIdList([], ["a"])).toBe(true);
    expect(isAppendOnlyIdList(["a", "b"], ["a", "c", "b"])).toBe(false);
    expect(isAppendOnlyIdList(["a", "b", "c"], ["a", "b"])).toBe(false);
  });
});
