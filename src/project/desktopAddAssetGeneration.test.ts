import { describe, expect, it } from "vitest";
import type { Creation, CreationUpsert } from "../library/types";
import {
  addAssetGenerationFromCreation,
  creationUpsertWithAddAssetGeneration,
  mergeAddAssetGenerationIntoRemoteJson,
  preserveDesktopAddAssetGeneration,
} from "./desktopAddAssetGeneration";
import type { AddAssetGeneration } from "./types";

const generation: AddAssetGeneration = {
  prompt: "creature walks",
  generatedAt: "2026-07-28T00:00:00.000Z",
  creationId: "gen-1",
  mode: "start_frame",
  model: "vidu/q3-turbo",
  provider: "replicate",
  methodId: "replicate_timeline_fill",
  startFrameFraming: "fill",
};

function baseCreation(remoteJson: string | null = "{}"): Creation {
  return {
    id: "gen-1",
    title: "Clip",
    mediaType: "video",
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: "/tmp/a.mp4",
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    downloadState: "local",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-07-28T00:00:00.000Z",
    filename: "a.mp4",
    description: null,
    color: null,
    status: "completed",
    width: 1280,
    height: 720,
    aspectRatio: "16:9",
    nsfw: false,
    isModeratedError: false,
    remoteJson,
  };
}

describe("desktopAddAssetGeneration", () => {
  it("round-trips generation through remoteJson", () => {
    const upsert = creationUpsertWithAddAssetGeneration(
      baseCreation(),
      generation,
    );
    expect(upsert.prompt).toBe("creature walks");
    expect(addAssetGenerationFromCreation(upsert)).toMatchObject(generation);
  });

  it("preserves prior desktop stamp when sync upsert lacks one", () => {
    const existing = creationUpsertWithAddAssetGeneration(
      baseCreation(),
      generation,
    );
    const remoteUpsert: CreationUpsert = {
      ...existing,
      prompt: null,
      remoteJson: JSON.stringify({ id: "gen-1", meta: { prompt: "api" } }),
    };
    const preserved = preserveDesktopAddAssetGeneration(
      remoteUpsert,
      baseCreation(existing.remoteJson),
    );
    expect(addAssetGenerationFromCreation(preserved)?.prompt).toBe(
      "creature walks",
    );
    expect(preserved.prompt).toBe("creature walks");
  });

  it("keeps cabinet desktop keys when merging generation", () => {
    const withCabinet = mergeAddAssetGenerationIntoRemoteJson(
      JSON.stringify({
        meta: { desktop: { role: "project_videos", client: "parascene-desktop" } },
      }),
      generation,
    );
    const parsed = JSON.parse(withCabinet) as {
      meta: { desktop: Record<string, unknown> };
    };
    expect(parsed.meta.desktop.role).toBe("project_videos");
    expect(parsed.meta.desktop.addAssetGeneration).toMatchObject({
      prompt: "creature walks",
    });
  });
});
