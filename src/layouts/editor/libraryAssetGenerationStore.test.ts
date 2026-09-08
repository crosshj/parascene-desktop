import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Creation } from "../../library/types";
import type { LibraryAssetPlaceholder } from "../../project/libraryAssetPlaceholder";
import type { ParasceneStillModelOption } from "./parasceneProductCaps";
import {
  __resetLibraryAssetGenerationStoreForTests,
  bindLibraryAssetGenerationApplier,
  cancelLibraryAssetGeneration,
  retryLibraryAssetPlaceholder,
  startLibraryParasceneImageToImage,
  startLibraryReplicateAudio,
  waitForCatalogLocalMedia,
} from "./libraryAssetGenerationStore";

const getCreation = vi.fn();

vi.mock("../../library/catalogClient", () => ({
  applyManifest: vi.fn(),
  getCreation: (...args: unknown[]) => getCreation(...args),
}));

vi.mock("./runParasceneImageToImage", () => ({
  runParasceneImageToImage: vi.fn(async () => ({
    creationId: "remote-99",
    projectCreationIds: [],
    imagesGroupId: null,
  })),
}));

const invokeReplicateGenerate = vi.fn(async (_opts: unknown) => ({
  mode: "job" as const,
  id: "job-audio",
}));
const watchLocalGenerateStill = vi.fn(
  async (_handle: unknown, _opts?: unknown) => ({
    creationId: "audio-99",
    localPaths: ["/tmp/audio-99.mp3"],
  }),
);
const cancelGenerateStillJob = vi.fn(async (_jobId: string) => {});

vi.mock("../../services/labGenerate", () => ({
  invokeReplicateGenerate: (opts: unknown) => invokeReplicateGenerate(opts),
  watchLabGenerate: vi.fn(),
}));

vi.mock("../../services/generateStill", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/generateStill")>();
  return {
    ...actual,
    watchLocalGenerateStill: (handle: unknown, opts?: unknown) =>
      watchLocalGenerateStill(handle, opts),
    cancelGenerateStillJob: (jobId: string) => cancelGenerateStillJob(jobId),
  };
});

vi.mock("../../replicate/replicateClient", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../replicate/replicateClient")>();
  return {
    ...actual,
    listenReplicateRunProgress: vi.fn(async () => () => {}),
    replicatePredictionWait: vi.fn(),
  };
});

vi.mock("./replicateAudioModels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./replicateAudioModels")>();
  return {
    ...actual,
    loadCuratedReplicateAudioModels: vi.fn(async () => [
      {
        id: "minimax/speech-2.8-hd",
        intentId: "text_to_speech",
        label: "MiniMax Speech 2.8 HD",
        hint: "Narration",
        textField: "text",
        owner: "minimax",
        name: "speech-2.8-hd",
        inputs: [],
      },
    ]),
  };
});

const blueRoute: ParasceneStillModelOption = {
  id: "6:image2image:qga10b_qgo10b",
  label: "qga10b_qgo10b",
  value: "qga10b_qgo10b",
  serverId: 6,
  method: "image2image",
  family: "blue",
  supportsInputImages: true,
};

vi.mock("./parasceneProductCaps", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./parasceneProductCaps")>();
  return {
    ...actual,
    parasceneResolveStillModel: () => blueRoute,
    parasceneStillModelFamilies: () => [
      {
        family: "blue",
        label: "Blue",
        models: [blueRoute],
      },
    ],
  };
});

function failedPlaceholder(
  patch: Partial<LibraryAssetPlaceholder> = {},
): LibraryAssetPlaceholder {
  return {
    id: "placeholder-retry",
    kind: "image",
    aspectRatio: "16:9",
    status: "error",
    addAssetDraft: {
      prompt: "make it blue",
      intentId: "image_to_image",
      server: "parascene_blue",
      provider: "parascene_blue",
      methodId: "image_to_image",
      replicateModel: blueRoute.value,
      startFrameAssetId: "source-1",
      lastError: "fetch failed",
    },
    progressNote: "fetch failed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...patch,
  };
}

describe("retryLibraryAssetPlaceholder", () => {
  beforeEach(() => {
    __resetLibraryAssetGenerationStoreForTests();
    getCreation.mockReset();
    getCreation.mockResolvedValue({
      id: "remote-99",
      localPath: "/tmp/remote-99.png",
      localThumbPath: "/tmp/remote-99.jpg",
    } as Creation);
    invokeReplicateGenerate.mockReset();
    watchLocalGenerateStill.mockReset();
    cancelGenerateStillJob.mockReset();
    invokeReplicateGenerate.mockResolvedValue({ mode: "job", id: "job-audio" });
    watchLocalGenerateStill.mockResolvedValue({
      creationId: "audio-99",
      localPaths: ["/tmp/audio-99.mp3"],
    });
    bindLibraryAssetGenerationApplier({
      beginPlaceholder: vi.fn(),
      onGenerationStarted: vi.fn(),
      patchPlaceholder: vi.fn(),
      completePlaceholder: vi.fn(),
      addCreations: vi.fn(async () => {}),
      setImagesGroupId: vi.fn(),
    });
  });

  it("restarts image-to-image on the same placeholder id", async () => {
    const id = await retryLibraryAssetPlaceholder({
      placeholder: failedPlaceholder(),
      projectId: "project-1",
      projectTitle: "Demo",
      imagesGroupId: null,
      videosGroupId: null,
    });
    expect(id).toBe("placeholder-retry");
  });

  it("passes placeholderId through to startLibraryParasceneImageToImage", () => {
    const beginPlaceholder = vi.fn();
    bindLibraryAssetGenerationApplier({
      beginPlaceholder,
      onGenerationStarted: vi.fn(),
      patchPlaceholder: vi.fn(),
      completePlaceholder: vi.fn(),
      addCreations: vi.fn(async () => {}),
      setImagesGroupId: vi.fn(),
    });

    startLibraryParasceneImageToImage({
      projectId: "project-1",
      projectTitle: "Demo",
      imagesGroupId: null,
      videosGroupId: null,
      aspectRatio: "16:9",
      prompt: "test",
      modelId: blueRoute.id,
      route: blueRoute,
      sourceCreationId: "source-1",
      placeholderId: "placeholder-retry",
    });

    expect(beginPlaceholder).toHaveBeenCalledWith(
      expect.objectContaining({ id: "placeholder-retry" }),
    );
  });

  it("retries speech with the persisted voice extras", async () => {
    const beginPlaceholder = vi.fn();
    bindLibraryAssetGenerationApplier({
      beginPlaceholder,
      onGenerationStarted: vi.fn(),
      patchPlaceholder: vi.fn(),
      completePlaceholder: vi.fn(),
      addCreations: vi.fn(async () => {}),
      setImagesGroupId: vi.fn(),
    });

    const id = await retryLibraryAssetPlaceholder({
      placeholder: {
        id: "audio-retry",
        kind: "audio",
        aspectRatio: "16:9",
        status: "error",
        addAssetDraft: {
          prompt: "hello there",
          intentId: "text_to_speech",
          server: "replicate",
          provider: "replicate",
          methodId: "text_to_speech",
          replicateModel: "minimax/speech-2.8-hd",
          audioExtras: { voiceId: "English_expressive_narrator" },
          lastError: "network",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      projectId: "project-1",
      projectTitle: "Demo",
      imagesGroupId: null,
      videosGroupId: null,
    });

    expect(id).toBe("audio-retry");
    expect(beginPlaceholder).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "audio-retry",
        kind: "audio",
        draft: expect.objectContaining({
          audioExtras: { voiceId: "English_expressive_narrator" },
        }),
      }),
    );
  });
});

describe("library audio generation lifecycle", () => {
  beforeEach(() => {
    __resetLibraryAssetGenerationStoreForTests();
    getCreation.mockReset();
    getCreation.mockResolvedValue({
      id: "audio-99",
      localPath: "/tmp/audio-99.mp3",
    } as Creation);
    invokeReplicateGenerate.mockReset();
    watchLocalGenerateStill.mockReset();
    cancelGenerateStillJob.mockReset();
    invokeReplicateGenerate.mockResolvedValue({ mode: "job", id: "job-audio" });
    watchLocalGenerateStill.mockResolvedValue({
      creationId: "audio-99",
      localPaths: ["/tmp/audio-99.mp3"],
    });
    cancelGenerateStillJob.mockResolvedValue(undefined);
  });

  it("starts speech with extras and persists the service job id", async () => {
    const beginPlaceholder = vi.fn();
    const patchPlaceholder = vi.fn();
    bindLibraryAssetGenerationApplier({
      beginPlaceholder,
      onGenerationStarted: vi.fn(),
      patchPlaceholder,
      completePlaceholder: vi.fn(),
      addCreations: vi.fn(async () => {}),
      setImagesGroupId: vi.fn(),
    });

    startLibraryReplicateAudio({
      projectId: "project-1",
      aspectRatio: "16:9",
      prompt: "hello there",
      intentId: "text_to_speech",
      modelId: "minimax/speech-2.8-hd",
      extras: { voiceId: "English_expressive_narrator" },
    });

    expect(beginPlaceholder).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "audio",
        draft: expect.objectContaining({
          audioExtras: { voiceId: "English_expressive_narrator" },
        }),
      }),
    );

    await vi.waitFor(() => {
      expect(invokeReplicateGenerate).toHaveBeenCalled();
    });
    expect(invokeReplicateGenerate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          text: "hello there",
          voice_id: "English_expressive_narrator",
        }),
      }),
    );
    await vi.waitFor(() => {
      expect(patchPlaceholder).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          addAssetDraft: expect.objectContaining({
            generationJob: expect.objectContaining({
              serviceJobId: "job-audio",
            }),
          }),
        }),
      );
    });
  });

  it("cancels the persisted service job id", () => {
    cancelLibraryAssetGeneration({
      id: "ph-audio",
      addAssetDraft: {
        prompt: "hello",
        intentId: "text_to_speech",
        server: "replicate",
        provider: "replicate",
        methodId: "text_to_speech",
        audioExtras: { voiceId: "English_expressive_narrator" },
        generationJob: {
          status: "waiting",
          provider: "replicate",
          startedAt: "2026-01-01T00:00:00.000Z",
          serviceJobId: "job-audio",
          model: "minimax/speech-2.8-hd",
        },
      },
    });
    expect(cancelGenerateStillJob).toHaveBeenCalledWith("job-audio");
  });
});

describe("waitForCatalogLocalMedia", () => {
  beforeEach(() => {
    getCreation.mockReset();
  });

  it("returns true once the catalog row has local files", async () => {
    getCreation
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce({
        id: "26053",
        localPath: null,
        localThumbPath: null,
      } as Creation)
      .mockResolvedValueOnce({
        id: "26053",
        localPath: "/tmp/26053.png",
        localThumbPath: "/tmp/26053.jpg",
      } as Creation);

    await expect(
      waitForCatalogLocalMedia("26053", { timeoutMs: 1_000, pollMs: 10 }),
    ).resolves.toBe(true);
  });

  it("returns false when files never land", async () => {
    getCreation.mockResolvedValue({
      id: "26053",
      localPath: null,
      localThumbPath: null,
    } as Creation);

    await expect(
      waitForCatalogLocalMedia("26053", { timeoutMs: 40, pollMs: 10 }),
    ).resolves.toBe(false);
  });
});
