import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/generateStill", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/generateStill")>();
  return {
    ...actual,
    runParasceneWaitCreation: vi.fn(),
    watchParasceneGenerate: vi.fn(),
  };
});
vi.mock("../../lab/ingestCreation", () => ({
  ingestRemoteCreation: vi.fn(),
}));
vi.mock("../../lab/projectGroups", () => ({
  fileCreationIntoProjectGroup: vi.fn(),
}));

import {
  runParasceneWaitCreation,
  watchParasceneGenerate,
} from "../../services/generateStill";
import { ingestRemoteCreation } from "../../lab/ingestCreation";
import { fileCreationIntoProjectGroup } from "../../lab/projectGroups";
import { resumeParasceneAddAssetGeneration } from "./addAssetGenerationResume";

const watchMock = vi.mocked(watchParasceneGenerate);
const waitMock = vi.mocked(runParasceneWaitCreation);
const ingestMock = vi.mocked(ingestRemoteCreation);
const fileMock = vi.mocked(fileCreationIntoProjectGroup);

function resumeOpts() {
  return {
    pendingCreationId: "30205",
    serviceJobId: "job-1",
    projectId: "p1",
    projectTitle: "Project",
    imagesGroupId: null,
    videosGroupId: null,
    continuityMode: "start_frame" as const,
    model: "ltx_i2v",
    onSteps: vi.fn(),
    onProgress: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  waitMock.mockResolvedValue({
    creationId: "30205",
    status: "complete",
    creation: { id: "30205" },
  });
  ingestMock.mockResolvedValue("30205");
  fileMock.mockResolvedValue({
    projectCreationIds: ["30205"],
    groupId: "g1",
  } as Awaited<ReturnType<typeof fileCreationIntoProjectGroup>>);
});

describe("resumeParasceneAddAssetGeneration", () => {
  it("watches the durable service job first — no second wait row", async () => {
    watchMock.mockResolvedValue({
      creationId: "30205",
      projectCreationIds: ["30205"],
      videosGroupId: "g1",
      imagesGroupId: null,
    } as Awaited<ReturnType<typeof watchParasceneGenerate>>);

    const result = await resumeParasceneAddAssetGeneration(resumeOpts());

    expect(result.creationId).toBe("30205");
    expect(watchMock).toHaveBeenCalledWith(
      { mode: "job", id: "job-1" },
      expect.anything(),
    );
    expect(waitMock).not.toHaveBeenCalled();
  });

  it("falls back to the creation wait when the service job stalls", async () => {
    watchMock.mockRejectedValue(new Error("Service run job-1 stalled"));

    const result = await resumeParasceneAddAssetGeneration(resumeOpts());

    expect(result.creationId).toBe("30205");
    expect(waitMock).toHaveBeenCalledWith(
      expect.objectContaining({ creationId: "30205" }),
    );
  });

  it("does not fall back on user cancellation", async () => {
    watchMock.mockRejectedValue(new Error("Cancelled"));

    await expect(
      resumeParasceneAddAssetGeneration(resumeOpts()),
    ).rejects.toThrow("Cancelled");
    expect(waitMock).not.toHaveBeenCalled();
  });

  it("still waits on the creation when there is no service job id", async () => {
    const opts = { ...resumeOpts(), serviceJobId: undefined };

    const result = await resumeParasceneAddAssetGeneration(opts);

    expect(result.creationId).toBe("30205");
    expect(watchMock).not.toHaveBeenCalled();
    expect(waitMock).toHaveBeenCalled();
  });
});
