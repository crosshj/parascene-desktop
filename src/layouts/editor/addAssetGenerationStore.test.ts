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

    const applySuccess = vi.fn();
    bindAddAssetGenerationApplier({ applySuccess });

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

  it("keeps error sessions until cleared", async () => {
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
    clearAddAssetGenerationError();
    expect(getAddAssetGenerationSession()).toBeNull();
  });
});
