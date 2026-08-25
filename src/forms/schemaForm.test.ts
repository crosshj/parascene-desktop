import { describe, expect, it } from "vitest";
import { enumGroupsFromColonLabels } from "./schemaForm";

describe("enumGroupsFromColonLabels", () => {
  it("groups Blue checkpoints by prefix in first-seen order", () => {
    expect(
      enumGroupsFromColonLabels([
        { id: "a", label: "flux: flux1-dev" },
        { id: "b", label: "sd15: cyberrealistic_v20" },
        { id: "c", label: "flux: getphatFLUXReality_v10FP8" },
      ]),
    ).toEqual([
      { label: "flux", values: ["a", "c"] },
      { label: "sd15", values: ["b"] },
    ]);
  });

  it("stays flat when every option shares one prefix", () => {
    expect(
      enumGroupsFromColonLabels([
        { id: "a", label: "flux: flux1-dev" },
        { id: "b", label: "flux: other" },
      ]),
    ).toBeUndefined();
  });
});
