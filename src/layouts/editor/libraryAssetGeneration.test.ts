import { describe, expect, it } from "vitest";
import type { LibraryAssetPlaceholder } from "../../project/libraryAssetPlaceholder";
import { libraryPlaceholderResultSteps } from "./libraryAssetGeneration";

function placeholder(
  patch: Partial<LibraryAssetPlaceholder> & {
    addAssetDraft?: Partial<LibraryAssetPlaceholder["addAssetDraft"]>;
  },
): LibraryAssetPlaceholder {
  return {
    id: "ph-1",
    kind: "image",
    aspectRatio: "16:9",
    status: "generating",
    addAssetDraft: {
      prompt: "test",
      intentId: "text_to_image",
      server: "parascene_blue",
      provider: "parascene_blue",
      methodId: "text_to_image",
      ...patch.addAssetDraft,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("libraryPlaceholderResultSteps", () => {
  it("marks the first step active while starting", () => {
    const steps = libraryPlaceholderResultSteps(
      placeholder({
        addAssetDraft: {
          generationJob: {
            status: "starting",
            provider: "parascene_blue",
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    expect(steps[0]?.status).toBe("active");
    expect(steps[1]?.status).toBe("pending");
  });

  it("advances to sync when progress mentions syncing", () => {
    const steps = libraryPlaceholderResultSteps(
      placeholder({
        progressNote: "Syncing to Library…",
        addAssetDraft: {
          generationJob: {
            status: "importing",
            provider: "parascene_blue",
            startedAt: "2026-01-01T00:00:00.000Z",
            pendingCreationId: "remote-1",
          },
        },
      }),
    );
    expect(steps[1]?.status).toBe("done");
    expect(steps[2]?.status).toBe("active");
  });
});
