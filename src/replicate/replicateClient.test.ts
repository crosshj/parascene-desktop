import { describe, expect, it } from "vitest";
import { parseReplicateOwnerName } from "./replicateClient";

describe("parseReplicateOwnerName", () => {
  it("parses a full owner/name slug", () => {
    expect(parseReplicateOwnerName("minimax/h3")).toEqual({
      owner: "minimax",
      name: "h3",
    });
  });

  it("rejects a prefix that is not a complete slug", () => {
    expect(parseReplicateOwnerName("minimax/h")).toBeNull();
    expect(parseReplicateOwnerName("minimax")).toBeNull();
    expect(parseReplicateOwnerName("minimax/hailuo 2")).toBeNull();
  });
});
