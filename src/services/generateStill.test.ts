import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { invokeParasceneGenerate } from "./generateStill";

describe("invokeParasceneGenerate", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ mode: "job", id: "job-1" });
  });

  it("reuses the placeholder as creation token and can resume a pending id", async () => {
    await invokeParasceneGenerate({
      projectId: "p1",
      projectTitle: "Demo",
      serverId: 6,
      method: "text2image",
      args: { prompt: "mushrooms" },
      clientRequestId: "placeholder-1",
      pendingCreationId: "25622",
    });
    expect(invoke).toHaveBeenCalledWith("service_invoke", {
      request: expect.objectContaining({
        clientRequestId: "placeholder-1",
        payload: expect.objectContaining({
          creationToken: "placeholder-1",
          pendingCreationId: "25622",
        }),
      }),
    });
  });
});
