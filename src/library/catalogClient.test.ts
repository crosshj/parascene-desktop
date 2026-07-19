import { beforeEach, describe, expect, it, vi } from "vitest";
import { existingCreationIds } from "./catalogClient";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("catalogClient existingCreationIds", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("short-circuits empty lookups", async () => {
    await expect(existingCreationIds([])).resolves.toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes the batched existence command", async () => {
    invoke.mockResolvedValueOnce(["2", "1"]);
    await expect(existingCreationIds(["1", "2", "3"])).resolves.toEqual([
      "2",
      "1",
    ]);
    expect(invoke).toHaveBeenCalledWith("library_existing_creation_ids", {
      ids: ["1", "2", "3"],
    });
  });
});
