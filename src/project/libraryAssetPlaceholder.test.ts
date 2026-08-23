import { describe, expect, it } from "vitest";
import {
  activeLibraryAssetPlaceholders,
  isActiveLibraryAssetPlaceholder,
  libraryAssetPlaceholderIdsInList,
  libraryAssetPlaceholderPhase,
  normalizeLibraryAssetPlaceholder,
  pendingLibraryPlaceholderCreationIds,
} from "./libraryAssetPlaceholder";

describe("libraryAssetPlaceholder", () => {
  it("normalizes generating placeholders with draft job state", () => {
    const row = normalizeLibraryAssetPlaceholder({
      id: "asset-1",
      kind: "image",
      aspectRatio: "9:16",
      status: "generating",
      addAssetDraft: {
        prompt: "sunset",
        generationJob: {
          status: "waiting",
          provider: "parascene_blue",
          startedAt: "2026-01-01T00:00:00.000Z",
          pendingCreationId: "remote-1",
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(row?.id).toBe("asset-1");
    expect(libraryAssetPlaceholderPhase(row)).toBe("running");
  });

  it("marks draft errors as error phase", () => {
    const row = normalizeLibraryAssetPlaceholder({
      id: "asset-2",
      kind: "image",
      aspectRatio: "16:9",
      status: "generating",
      addAssetDraft: {
        prompt: "fail",
        lastError: "boom",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(libraryAssetPlaceholderPhase(row)).toBe("error");
  });

  it("treats generating placeholders without an active job as pre_gen", () => {
    const row = normalizeLibraryAssetPlaceholder({
      id: "asset-3",
      kind: "image",
      aspectRatio: "16:9",
      status: "generating",
      addAssetDraft: {
        prompt: "retry me",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(libraryAssetPlaceholderPhase(row)).toBe("pre_gen");
  });

  it("detects active placeholders and ids in a selection list", () => {
    const placeholders = {
      "ph-1": normalizeLibraryAssetPlaceholder({
        id: "ph-1",
        kind: "image",
        aspectRatio: "16:9",
        status: "error",
        addAssetDraft: { prompt: "fail", lastError: "boom" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })!,
      "ph-2": normalizeLibraryAssetPlaceholder({
        id: "ph-2",
        kind: "image",
        aspectRatio: "16:9",
        status: "done",
        addAssetDraft: { prompt: "done" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })!,
    };
    expect(isActiveLibraryAssetPlaceholder(placeholders["ph-1"])).toBe(true);
    expect(isActiveLibraryAssetPlaceholder(placeholders["ph-2"])).toBe(false);
    expect(
      libraryAssetPlaceholderIdsInList(placeholders, [
        "ph-1",
        "c1",
        "ph-2",
      ]),
    ).toEqual(["ph-1", "ph-2"]);
  });

  it("orders active placeholders by createdAt, not updatedAt", () => {
    const placeholders = {
      "ph-new": normalizeLibraryAssetPlaceholder({
        id: "ph-new",
        kind: "image",
        aspectRatio: "16:9",
        status: "error",
        addAssetDraft: { prompt: "newer", lastError: "boom" },
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      })!,
      "ph-old": normalizeLibraryAssetPlaceholder({
        id: "ph-old",
        kind: "image",
        aspectRatio: "16:9",
        status: "generating",
        addAssetDraft: {
          prompt: "older",
          generationJob: {
            status: "waiting",
            provider: "parascene_blue",
            startedAt: "2026-01-02T00:00:00.000Z",
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      })!,
    };
    expect(activeLibraryAssetPlaceholders(placeholders).map((row) => row.id)).toEqual(
      ["ph-old", "ph-new"],
    );
  });

  it("collects pending remote creation ids for active placeholders", () => {
    const active = activeLibraryAssetPlaceholders({
      "ph-1": normalizeLibraryAssetPlaceholder({
        id: "ph-1",
        kind: "image",
        aspectRatio: "16:9",
        status: "generating",
        addAssetDraft: {
          prompt: "wait",
          generationJob: {
            status: "waiting",
            provider: "parascene_blue",
            startedAt: "2026-01-01T00:00:00.000Z",
            pendingCreationId: "remote-42",
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })!,
    });
    expect(pendingLibraryPlaceholderCreationIds(active)).toEqual(
      new Set(["remote-42"]),
    );
  });
});
