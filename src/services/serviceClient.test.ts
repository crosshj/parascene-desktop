import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

import {
  serviceCancel,
  serviceDescribe,
  serviceGet,
  serviceInvoke,
  serviceList,
  serviceListRuns,
  watchService,
} from "./serviceClient";
import type { ServiceRun } from "./types";

function run(partial: Partial<ServiceRun> & { id: string }): ServiceRun {
  return {
    kind: "ensure_project_groups",
    status: "queued",
    payloadJson: "{}",
    createdAt: "t0",
    updatedAt: "t0",
    ...partial,
  };
}

describe("serviceClient", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
    listen.mockResolvedValue(() => {});
  });

  it("serviceList / describe / invoke / get / cancel / listRuns call commands", async () => {
    invoke.mockResolvedValueOnce([]);
    await serviceList();
    expect(invoke).toHaveBeenCalledWith("service_list");

    invoke.mockResolvedValueOnce({
      service: "parascene",
      operation: "ensure_project_groups",
      status: "wired",
      fields: [],
    });
    await serviceDescribe({
      service: "parascene",
      operation: "ensure_project_groups",
    });
    expect(invoke).toHaveBeenCalledWith("service_describe", {
      request: {
        service: "parascene",
        operation: "ensure_project_groups",
      },
    });

    invoke.mockResolvedValueOnce({ mode: "job", id: "j1" });
    await serviceInvoke({
      service: "parascene",
      operation: "ensure_project_groups",
      payload: { projectId: "p1" },
      projectId: "p1",
    });
    expect(invoke).toHaveBeenCalledWith("service_invoke", {
      request: {
        service: "parascene",
        operation: "ensure_project_groups",
        payload: { projectId: "p1" },
        projectId: "p1",
      },
    });

    invoke.mockResolvedValueOnce(run({ id: "j1" }));
    await serviceGet("j1");
    expect(invoke).toHaveBeenCalledWith("service_get", { id: "j1" });

    invoke.mockResolvedValueOnce(run({ id: "j1", status: "cancelled" }));
    await serviceCancel("j1");
    expect(invoke).toHaveBeenCalledWith("service_cancel", { id: "j1" });

    invoke.mockResolvedValueOnce([]);
    await serviceListRuns({ projectId: "p1", limit: 10 });
    expect(invoke).toHaveBeenCalledWith("service_list_runs", {
      projectId: "p1",
      status: null,
      limit: 10,
    });
  });

  it("watchService resolves immediately for terminal runs", async () => {
    invoke.mockResolvedValueOnce(run({ id: "j1", status: "done" }));
    const result = await watchService({ mode: "job", id: "j1" });
    expect(result.status).toBe("done");
  });

  it("watchService rejects result handles", async () => {
    await expect(
      watchService({ mode: "result", data: { ok: true } }),
    ).rejects.toThrow(/job handle/);
  });
});
