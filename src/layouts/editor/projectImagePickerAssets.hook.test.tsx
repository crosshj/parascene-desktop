import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Creation } from "../../library/types";
import type { ProjectAsset } from "../../project/types";
import {
  getEditorWorkCounters,
  resetEditorWorkCounters,
} from "./editorWorkCounters";

const getCreations = vi.fn();
const applyManifest = vi.fn();
let listenResolve: ((off: () => void) => void) | null = null;

vi.mock("../../library/catalogClient", () => ({
  getCreations: (...args: unknown[]) => getCreations(...args),
  applyManifest: (...args: unknown[]) => applyManifest(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    () =>
      new Promise<() => void>((resolve) => {
        listenResolve = resolve;
      }),
  ),
}));

import { useProjectPickerCatalog } from "./projectImagePickerAssets";

function stubCreation(id: string): Creation {
  return {
    id,
    title: id,
    mediaType: "image",
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: `/tmp/${id}.png`,
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    downloadState: "local",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    filename: `${id}.png`,
    description: null,
    color: null,
    status: null,
    width: null,
    height: null,
    aspectRatio: null,
    nsfw: false,
    isModeratedError: false,
    remoteJson: null,
  };
}

describe("useProjectPickerCatalog", () => {
  beforeEach(() => {
    getCreations.mockReset();
    applyManifest.mockReset();
    listenResolve = null;
    resetEditorWorkCounters();
    getCreations.mockResolvedValue([stubCreation("img-1")]);
  });

  it("loads the catalog once for stable assets and equivalent context", async () => {
    const assets: ProjectAsset[] = [{ id: "img-1", name: "Still", kind: "image" }];
    const { rerender, result } = renderHook(
      ({ ctx }) => useProjectPickerCatalog(assets, ctx),
      {
        initialProps: {
          ctx: {
            projectId: "p1",
            projectTitle: "Demo",
            projectCabinets: {
              imagesGroupId: "100",
              videosGroupId: null,
            },
          },
        },
      },
    );

    await waitFor(() => {
      expect(result.current.assets.map((row) => row.id)).toEqual(["img-1"]);
    });
    expect(getEditorWorkCounters().catalogLoads).toBe(1);

    rerender({
      ctx: {
        projectId: "p1",
        projectTitle: "Demo",
        projectCabinets: {
          imagesGroupId: "100",
          videosGroupId: null,
        },
      },
    });
    await Promise.resolve();
    expect(getEditorWorkCounters().catalogLoads).toBe(1);

    rerender({
      ctx: {
        projectId: "p2",
        projectTitle: "Demo",
        projectCabinets: {
          imagesGroupId: "100",
          videosGroupId: null,
        },
      },
    });
    await waitFor(() => {
      expect(getEditorWorkCounters().catalogLoads).toBe(2);
    });
  });

  it("removes a listener that resolves after unmount", async () => {
    const assets: ProjectAsset[] = [{ id: "img-1", name: "Still", kind: "image" }];
    const { unmount } = renderHook(() =>
      useProjectPickerCatalog(assets, {
        projectId: "p1",
        projectTitle: "Demo",
        projectCabinets: null,
      }),
    );
    await waitFor(() => {
      expect(listenResolve).not.toBeNull();
    });
    unmount();
    const off = vi.fn();
    listenResolve?.(off);
    await waitFor(() => {
      expect(off).toHaveBeenCalledTimes(1);
    });
    expect(getEditorWorkCounters().libraryListeners).toBe(0);
  });
});
