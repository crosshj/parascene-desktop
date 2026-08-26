import { describe, expect, it } from "vitest";
import {
  assetRef,
  dualPhaseFromActivity,
  isAssetRef,
  isTerminalActivityState,
  parseJsonBlob,
  progressMessagesFromRun,
  type ServiceRun,
} from "./types";

describe("assetRef", () => {
  it("trims id", () => {
    expect(assetRef("  abc  ")).toEqual({ id: "abc" });
  });

  it("isAssetRef rejects empty and non-objects", () => {
    expect(isAssetRef(null)).toBe(false);
    expect(isAssetRef({ id: "" })).toBe(false);
    expect(isAssetRef({ id: "  " })).toBe(false);
    expect(isAssetRef({ id: "x" })).toBe(true);
  });
});

describe("activity helpers", () => {
  it("isTerminalActivityState", () => {
    expect(isTerminalActivityState("done")).toBe(true);
    expect(isTerminalActivityState("failed")).toBe(true);
    expect(isTerminalActivityState("cancelled")).toBe(true);
    expect(isTerminalActivityState("running")).toBe(false);
    expect(isTerminalActivityState("waiting")).toBe(false);
  });

  it("dualPhaseFromActivity maps handle status to Form chrome", () => {
    expect(dualPhaseFromActivity(null)).toBe("pre_gen");
    expect(dualPhaseFromActivity("queued")).toBe("pre_gen");
    expect(dualPhaseFromActivity("running")).toBe("running");
    expect(dualPhaseFromActivity("waiting")).toBe("running");
    expect(dualPhaseFromActivity("done")).toBe("done");
    expect(dualPhaseFromActivity("failed")).toBe("error");
    expect(dualPhaseFromActivity("cancelled")).toBe("error");
  });
});

describe("progressMessagesFromRun", () => {
  const base: ServiceRun = {
    id: "j1",
    kind: "ensure_project_groups",
    status: "running",
    payloadJson: "{}",
    createdAt: "t0",
    updatedAt: "t1",
  };

  it("prefers checkpoint messages", () => {
    expect(
      progressMessagesFromRun({
        ...base,
        progressNote: "note",
        checkpointJson: JSON.stringify({ messages: ["a", "b"] }),
      }),
    ).toEqual(["a", "b"]);
  });

  it("falls back to progressNote", () => {
    expect(
      progressMessagesFromRun({
        ...base,
        progressNote: "Working…",
      }),
    ).toEqual(["Working…"]);
  });

  it("parseJsonBlob returns null on bad json", () => {
    expect(parseJsonBlob("{")).toBeNull();
    expect(parseJsonBlob(null)).toBeNull();
    expect(parseJsonBlob('{"x":1}')).toEqual({ x: 1 });
  });
});
