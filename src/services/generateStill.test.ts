import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  invokeParasceneGenerate,
  predictionIdFromServiceRun,
} from "./generateStill";

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

describe("predictionIdFromServiceRun", () => {
  it("reads the Replicate prediction id from the job result", () => {
    expect(
      predictionIdFromServiceRun({
        id: "job-1",
        kind: "replicate.generate",
        status: "running",
        payloadJson: "{}",
        resultJson: JSON.stringify({ predictionId: "pred-lyria" }),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("pred-lyria");
  });
});
