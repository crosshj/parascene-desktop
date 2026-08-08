import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  __resetAddAssetGenerationStoreForTests,
  bindAddAssetGenerationApplier,
  clearAddAssetGenerationError,
  clearAddAssetGenerationIfClipMissing,
  getAddAssetGenerationSession,
  isAddAssetGenerationInflight,
  startAddAssetGenerationJob,
  subscribeAddAssetGeneration,
} from "./addAssetGenerationStore";
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

import { runAddAssetGeneration } from "./addAssetGenerate";

const runMock = vi.mocked(runAddAssetGeneration);

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
  });

  it("keeps the session after start so remounts can resume UI", async () => {
    let resolveJob!: (value: {
      creationId: string;
      projectCreationIds: string[];
      videosGroupId: string | null;
      imagesGroupId: string | null;
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

    // Second start is ignored while inflight.
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

  it("clears when the placeholder clip is missing", () => {
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
    expect(isAddAssetGenerationInflight()).toBe(false);
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
    });
    clearAddAssetGenerationError();
    expect(getAddAssetGenerationSession()).toBeNull();
    expect(clearFailure).toHaveBeenCalledWith("proj-1", "ph-1");
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
});
