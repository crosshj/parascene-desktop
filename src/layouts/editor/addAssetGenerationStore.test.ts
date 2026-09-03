import { describe, expect, it, beforeEach, vi } from "vitest";
import type { StartAddAssetGenerationRequest } from "./AddAssetGeneratePanel";

vi.mock("./addAssetGenerate", async () => {
  const actual = await vi.importActual<typeof import("./addAssetGenerate")>(
    "./addAssetGenerate",
  );
  return {
    ...actual,
    runAddAssetGeneration: vi.fn(),
  };
});

vi.mock("../../project/projectAssetLanding", () => ({
  importLocalPathsForProject: vi.fn(),
}));

vi.mock("./addAssetBlueDirectGenerate", async () => {
  const actual =
    await vi.importActual<typeof import("./addAssetBlueDirectGenerate")>(
      "./addAssetBlueDirectGenerate",
    );
  return {
    ...actual,
    resumeBlueDirectAddAssetWait: vi.fn(),
  };
});

import { runAddAssetGeneration } from "./addAssetGenerate";
import { resumeBlueDirectAddAssetWait } from "./addAssetBlueDirectGenerate";
import { importLocalPathsForProject } from "../../project/projectAssetLanding";
import {
  __resetAddAssetGenerationStoreForTests,
  bindAddAssetGenerationApplier,
  clearAddAssetGenerationError,
  clearAddAssetGenerationIfClipMissing,
  getAddAssetGenerationSession,
  generateFolderIdsToFile,
  isAddAssetGenerationInflight,
  reconcileAddAssetGenerations,
  startAddAssetGenerationJob,
  subscribeAddAssetGeneration,
} from "./addAssetGenerationStore";

const runMock = vi.mocked(runAddAssetGeneration);
const resumeBlueMock = vi.mocked(resumeBlueDirectAddAssetWait);

describe("generateFolderIdsToFile", () => {
  it("files the Videos cover, not the generated member", () => {
    expect(
      generateFolderIdsToFile({
        projectCreationIds: ["26053", "26040"],
        videosGroupId: "26040",
        imagesGroupId: "18842",
      }),
    ).toEqual(["26040", "18842"]);
  });

  it("files returned ids when there is no cabinet cover (local-only)", () => {
    expect(
      generateFolderIdsToFile({
        projectCreationIds: ["local-vid"],
        videosGroupId: null,
        imagesGroupId: null,
      }),
    ).toEqual(["local-vid"]);
  });
});

function makeRequest(): StartAddAssetGenerationRequest {
  return {
    clip: {
      id: "ph-1",
      label: "0:09",
      startSec: 10,
      endSec: 19,
      lane: "video",
      kind: "video",
      isAddAssetPlaceholder: true,
    },
    prompt: "bridge",
    lyricsText: "",
    audioMode: "full_mix",
    continuityMode: "first_last",
    songRange: { startSec: 10, endSec: 19 },
    startFrame: {
      previewUrl: null,
      note: "",
      framePath: "/tmp/first.jpg",
      frameTimeSec: 0,
    },
    endFrame: {
      previewUrl: null,
      note: "",
      framePath: "/tmp/last.jpg",
      frameTimeSec: 0,
    },
  };
}

describe("addAssetGenerationStore", () => {
  beforeEach(() => {
    __resetAddAssetGenerationStoreForTests();
    runMock.mockReset();
    resumeBlueMock.mockReset();
  });

  it("keeps the session after start so remounts can resume UI", async () => {
    let resolveJob!: (value: {
      creationId: string;
      projectCreationIds: string[];
      videosGroupId: string | null;
      imagesGroupId: string | null;
      startFrameCreationId: string | null;
      endFrameCreationId: string | null;
      mode: "first_last";
      model: string;
    }) => void;
    runMock.mockReturnValue(
      new Promise((resolve) => {
        resolveJob = resolve;
      }),
    );

    const applySuccess = vi.fn();
    const applyFailure = vi.fn();
    const clearFailure = vi.fn();
    const applyInFlight = vi.fn();
    bindAddAssetGenerationApplier({
      applySuccess,
      applyFailure,
      clearFailure,
      applyInFlight,
    });

    const started = startAddAssetGenerationJob({
      projectId: "proj-1",
      request: makeRequest(),
      runOpts: {
        timeline: [],
        mainAudioCreationId: "audio-1",
        aspectRatio: "16:9",
        projectId: "proj-1",
        projectTitle: "Demo",
        imagesGroupId: null,
        videosGroupId: null,
      },
    });
    expect(started).toBe(true);
    expect(isAddAssetGenerationInflight()).toBe(true);
    expect(getAddAssetGenerationSession()?.clipId).toBe("ph-1");
    expect(getAddAssetGenerationSession()?.projectId).toBe("proj-1");
    expect(getAddAssetGenerationSession()?.phase).toBe("running");
    expect(applyInFlight).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        clipId: "ph-1",
        job: expect.objectContaining({
          status: "starting",
          provider: "parascene_blue",
        }),
      }),
    );

    // Second start on the same clip is ignored while inflight.
    expect(
      startAddAssetGenerationJob({
        projectId: "proj-1",
        request: makeRequest(),
        runOpts: {
          timeline: [],
          mainAudioCreationId: "audio-1",
          aspectRatio: "16:9",
          projectId: "proj-1",
          projectTitle: "Demo",
          imagesGroupId: null,
          videosGroupId: null,
        },
      }),
    ).toBe(false);

    resolveJob({
      creationId: "vid-1",
      projectCreationIds: ["vid-1"],
      videosGroupId: "vg",
      imagesGroupId: null,
      startFrameCreationId: null,
      endFrameCreationId: null,
      mode: "first_last",
      model: "wan_i2v",
    });
    await vi.waitFor(() => {
      expect(getAddAssetGenerationSession()).toBeNull();
      expect(isAddAssetGenerationInflight()).toBe(false);
    });

    expect(applySuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        clipId: "ph-1",
        creationId: "vid-1",
        mode: "first_last",
        model: "wan_i2v",
      }),
    );
  });

  it("lets a second clip generate while another clip is inflight", () => {
    runMock.mockReturnValue(new Promise(() => {}));
    bindAddAssetGenerationApplier({
      applySuccess: vi.fn(),
      applyFailure: vi.fn(),
      clearFailure: vi.fn(),
      applyInFlight: vi.fn(),
    });
    const runOpts = {
      timeline: [],
      mainAudioCreationId: "audio-1",
      aspectRatio: "16:9",
      projectId: "proj-1",
      projectTitle: "Demo",
      imagesGroupId: null,
      videosGroupId: null,
    };
    expect(
      startAddAssetGenerationJob({
        projectId: "proj-1",
        request: makeRequest(),
        runOpts,
      }),
    ).toBe(true);
    const second = makeRequest();
    second.clip = { ...second.clip, id: "ph-2" };
    expect(
      startAddAssetGenerationJob({
        projectId: "proj-1",
        request: second,
        runOpts,
      }),
    ).toBe(true);
    expect(isAddAssetGenerationInflight("ph-1")).toBe(true);
    expect(isAddAssetGenerationInflight("ph-2")).toBe(true);
    expect(getAddAssetGenerationSession("ph-1")?.clipId).toBe("ph-1");
    expect(getAddAssetGenerationSession("ph-2")?.clipId).toBe("ph-2");
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("notifies subscribers on session updates", async () => {
    runMock.mockReturnValue(new Promise(() => {}));
    const listener = vi.fn();
    const unsubscribe = subscribeAddAssetGeneration(listener);

    startAddAssetGenerationJob({
      projectId: "proj-1",
      request: makeRequest(),
      runOpts: {
        timeline: [],
        mainAudioCreationId: null,
        aspectRatio: "16:9",
        projectId: "proj-1",
        projectTitle: "Demo",
        imagesGroupId: null,
        videosGroupId: null,
      },
    });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("clears session UI when the placeholder clip is missing without releasing inflight", () => {
    runMock.mockReturnValue(new Promise(() => {}));
    startAddAssetGenerationJob({
      projectId: "proj-1",
      request: makeRequest(),
      runOpts: {
        timeline: [],
        mainAudioCreationId: null,
        aspectRatio: "16:9",
        projectId: "proj-1",
        projectTitle: "Demo",
        imagesGroupId: null,
        videosGroupId: null,
      },
    });
    clearAddAssetGenerationIfClipMissing(["other"]);
    expect(getAddAssetGenerationSession()).toBeNull();
    // Inflight stays true until the job promise settles — otherwise reconcile
    // can start a second import of the same remote job.
    expect(isAddAssetGenerationInflight()).toBe(true);
  });

  it("keeps error sessions until cleared and persists via applier", async () => {
    const applySuccess = vi.fn();
    const applyFailure = vi.fn();
    const clearFailure = vi.fn();
    const applyInFlight = vi.fn();
    bindAddAssetGenerationApplier({
      applySuccess,
      applyFailure,
      clearFailure,
      applyInFlight,
    });
    runMock.mockRejectedValue(new Error("boom"));
    startAddAssetGenerationJob({
      projectId: "proj-1",
      request: makeRequest(),
      runOpts: {
        timeline: [],
        mainAudioCreationId: null,
        aspectRatio: "16:9",
        projectId: "proj-1",
        projectTitle: "Demo",
        imagesGroupId: null,
        videosGroupId: null,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(getAddAssetGenerationSession()?.phase).toBe("error");
    expect(getAddAssetGenerationSession()?.errorMessage).toBe("boom");
    expect(applyInFlight).toHaveBeenCalled();
    expect(applyFailure).toHaveBeenCalledWith({
      projectId: "proj-1",
      clipId: "ph-1",
      errorMessage: "boom",
      replicatePredictionId: null,
      blueJobId: null,
      pendingCreationId: null,
    });
    clearAddAssetGenerationError();
    expect(getAddAssetGenerationSession()).toBeNull();
    expect(clearFailure).toHaveBeenCalledWith("proj-1", "ph-1");
  });

  it("cancel returns the clip to the form — no error card, no stale job", async () => {
    const applyFailure = vi.fn();
    const clearFailure = vi.fn();
    bindAddAssetGenerationApplier({
      applySuccess: vi.fn(),
      applyFailure,
      clearFailure,
      applyInFlight: vi.fn(),
    });
    let rejectJob!: (err: Error) => void;
    runMock.mockReturnValue(
      new Promise((_, reject) => {
        rejectJob = reject;
      }),
    );
    startAddAssetGenerationJob({
      projectId: "proj-1",
      request: makeRequest(),
      runOpts: {
        timeline: [],
        mainAudioCreationId: null,
        aspectRatio: "16:9",
        projectId: "proj-1",
        projectTitle: "Demo",
        imagesGroupId: null,
        videosGroupId: null,
      },
    });
    const { cancelAddAssetGeneration } = await import(
      "./addAssetGenerationStore"
    );
    cancelAddAssetGeneration("ph-1");
    expect(getAddAssetGenerationSession()?.progressNote).toBe("Cancelling…");

    rejectJob(new Error("Cancelled"));
    await vi.waitFor(() => {
      expect(getAddAssetGenerationSession()).toBeNull();
      expect(isAddAssetGenerationInflight()).toBe(false);
    });
    expect(applyFailure).not.toHaveBeenCalled();
    expect(clearFailure).toHaveBeenCalledWith("proj-1", "ph-1");
  });

  it("a kernel-cancelled run never shows an error card", async () => {
    const applyFailure = vi.fn();
    const clearFailure = vi.fn();
    bindAddAssetGenerationApplier({
      applySuccess: vi.fn(),
      applyFailure,
      clearFailure,
      applyInFlight: vi.fn(),
    });
    runMock.mockRejectedValue(new Error("Cancelled"));
    startAddAssetGenerationJob({
      projectId: "proj-1",
      request: makeRequest(),
      runOpts: {
        timeline: [],
        mainAudioCreationId: null,
        aspectRatio: "16:9",
        projectId: "proj-1",
        projectTitle: "Demo",
        imagesGroupId: null,
        videosGroupId: null,
      },
    });
    await vi.waitFor(() => {
      expect(getAddAssetGenerationSession()).toBeNull();
    });
    expect(applyFailure).not.toHaveBeenCalled();
    expect(clearFailure).toHaveBeenCalledWith("proj-1", "ph-1");
  });

  it("clears a timed-out clip while another generation is running", async () => {
    const clearFailure = vi.fn();
    bindAddAssetGenerationApplier({
      applySuccess: vi.fn(),
      applyFailure: vi.fn(),
      clearFailure,
      applyInFlight: vi.fn(),
    });
    runMock.mockImplementation(() => new Promise(() => {}));
    startAddAssetGenerationJob({
      projectId: "proj-1",
      request: { ...makeRequest(), clip: { ...makeRequest().clip, id: "ph-running" } },
      runOpts: {
        timeline: [],
        mainAudioCreationId: null,
        aspectRatio: "16:9",
        projectId: "proj-1",
        projectTitle: "Demo",
        imagesGroupId: null,
        videosGroupId: null,
      },
    });
    expect(getAddAssetGenerationSession()?.clipId).toBe("ph-running");
    expect(getAddAssetGenerationSession()?.phase).toBe("running");

    clearAddAssetGenerationError({
      projectId: "proj-1",
      clipId: "ph-timed-out",
    });

    expect(clearFailure).toHaveBeenCalledWith("proj-1", "ph-timed-out");
    expect(getAddAssetGenerationSession()?.clipId).toBe("ph-running");
    expect(getAddAssetGenerationSession()?.phase).toBe("running");
  });

  it("persists remote job ids via onRemoteJob for restart resume", async () => {
    const applyInFlight = vi.fn();
    bindAddAssetGenerationApplier({
      applySuccess: vi.fn(),
      applyFailure: vi.fn(),
      clearFailure: vi.fn(),
      applyInFlight,
    });
    runMock.mockImplementation(async (opts) => {
      opts.onRemoteJob?.({
        provider: "replicate",
        replicatePredictionId: "pred-xyz",
        model: "owner/model",
      });
      return {
        creationId: "vid-1",
        projectCreationIds: ["vid-1"],
        videosGroupId: null,
        imagesGroupId: null,
        startFrameCreationId: null,
        endFrameCreationId: null,
        mode: "start_frame" as const,
        model: "owner/model",
      };
    });
    startAddAssetGenerationJob({
      projectId: "proj-1",
      request: {
        ...makeRequest(),
        continuityMode: "start_frame",
        replicate: {
          owner: "owner",
          name: "model",
          inputs: [],
        },
      },
      runOpts: {
        timeline: [],
        mainAudioCreationId: null,
        aspectRatio: "16:9",
        projectId: "proj-1",
        projectTitle: "Demo",
        imagesGroupId: null,
        videosGroupId: null,
      },
    });
    await vi.waitFor(() => {
      expect(isAddAssetGenerationInflight()).toBe(false);
    });
    expect(applyInFlight).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({
          status: "waiting",
          provider: "replicate",
          replicatePredictionId: "pred-xyz",
        }),
      }),
    );
  });

  it("does not re-import the same Blue job when reconcile sees a stale placeholder", async () => {
    const applySuccess = vi.fn().mockResolvedValue(undefined);
    bindAddAssetGenerationApplier({
      applySuccess,
      applyFailure: vi.fn(),
      clearFailure: vi.fn(),
      applyInFlight: vi.fn(),
    });

    let importCount = 0;
    resumeBlueMock.mockImplementation(async () => {
      importCount += 1;
      return {
        creationId: `vid-${importCount}`,
        projectCreationIds: [`vid-${importCount}`],
        videosGroupId: null,
        imagesGroupId: null,
        startFrameCreationId: null,
        endFrameCreationId: null,
        mode: "start_frame" as const,
        model: "ltx_i2v",
      };
    });

    const staleTimeline = [
      {
        id: "ph-1",
        label: "0:04",
        startSec: 0,
        endSec: 4,
        lane: "video" as const,
        kind: "video" as const,
        isAddAssetPlaceholder: true,
        addAssetDraft: {
          prompt: "glow",
          continuityMode: "start_frame" as const,
          provider: "blue_direct" as const,
          generationJob: {
            status: "waiting" as const,
            provider: "blue_direct" as const,
            startedAt: new Date().toISOString(),
            blueJobId: "blue-job-1",
            model: "ltx_i2v",
          },
        },
      },
    ];

    const opts = {
      projectId: "proj-1",
      projectTitle: "Demo",
      timeline: staleTimeline,
      imagesGroupId: null,
      videosGroupId: null,
    };

    expect(reconcileAddAssetGenerations(opts)).toBe(true);
    await vi.waitFor(() => {
      expect(applySuccess).toHaveBeenCalledTimes(1);
      expect(isAddAssetGenerationInflight()).toBe(false);
    });

    // Stale snapshot still has the placeholder — must not import again.
    expect(reconcileAddAssetGenerations(opts)).toBe(false);
    expect(importCount).toBe(1);
    expect(applySuccess).toHaveBeenCalledTimes(1);
  });

  it("Parascene success stamps Creation still and does not flatten it or import local-*", async () => {
    const importLocal = vi.mocked(importLocalPathsForProject);
    importLocal.mockReset();
    runMock.mockResolvedValue({
      creationId: "vid-1",
      projectCreationIds: ["videos-group-1"],
      videosGroupId: "videos-group-1",
      imagesGroupId: "images-group-1",
      startFrameCreationId: "still-creation-9",
      endFrameCreationId: null,
      mode: "start_frame",
      model: "ltx_i2v",
    });

    const applySuccess = vi.fn();
    bindAddAssetGenerationApplier({
      applySuccess,
      applyFailure: vi.fn(),
      clearFailure: vi.fn(),
      applyInFlight: vi.fn(),
    });

    const request = makeRequest();
    request.continuityMode = "start_frame";
    request.clip = {
      ...request.clip,
      addAssetDraft: {
        startFrameAssetId: "local-bridge-extract",
        firstFrameSource: { kind: "asset", assetId: "local-bridge-extract" },
        server: "parascene_blue",
      },
    };

    startAddAssetGenerationJob({
      projectId: "proj-1",
      request,
      runOpts: {
        timeline: [],
        mainAudioCreationId: "audio-1",
        aspectRatio: "16:9",
        projectId: "proj-1",
        projectTitle: "Demo",
        imagesGroupId: "images-group-1",
        videosGroupId: "videos-group-1",
      },
    });

    await vi.waitFor(() => {
      expect(applySuccess).toHaveBeenCalled();
    });

    expect(importLocal).not.toHaveBeenCalled();
    expect(applySuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        creationId: "vid-1",
        startFrameAssetId: "still-creation-9",
        firstFrameSource: { kind: "asset", assetId: "still-creation-9" },
        projectCreationIds: ["videos-group-1", "images-group-1"],
        projectCreationIdsToRemove: ["local-bridge-extract"],
      }),
    );
  });

});
