import { describe, expect, it } from "vitest";
import type { Creation } from "../library/types";
import { leftoverVideoIdsToHide } from "./runAgentA2v";

function row(
  id: string,
  patch: Partial<Creation> = {},
): Creation {
  return {
    id,
    title: id,
    mediaType: "image",
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: null,
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
    ...patch,
  };
}

function videosCabinet(id: string, memberIds: string[]): Creation {
  return row(id, {
    title: "Parascene Desktop · Journey · Videos",
    filename: `group/${id}.png`,
    remoteJson: JSON.stringify({
      meta: {
        group: {
          kind: "group_creations",
          source_creation_ids: memberIds,
        },
        desktop: {
          role: "project_videos",
          client: "parascene-desktop",
          projectId: "proj-1",
        },
      },
    }),
  });
}

describe("leftoverVideoIdsToHide", () => {
  it("hides the Videos cabinet and its members, keeps still and audio", async () => {
    const catalog: Record<string, Creation> = {
      still: row("still"),
      audio: row("audio", { mediaType: "audio", filename: "speech.wav" }),
      vg: videosCabinet("vg", ["clip"]),
      clip: row("clip", { mediaType: "video", filename: "clip.mp4" }),
    };
    const hide = await leftoverVideoIdsToHide({
      creationIds: ["still", "audio", "vg"],
      videosGroupId: "vg",
      keepIds: ["still", "audio"],
      lookup: async (id) => catalog[id] ?? null,
    });
    expect(hide.sort()).toEqual(["clip", "vg"]);
  });

  it("hides a leftover Videos cabinet even after videosGroupId was cleared", async () => {
    const catalog: Record<string, Creation> = {
      still: row("still"),
      vg: videosCabinet("vg", ["clip"]),
      clip: row("clip", { mediaType: "video" }),
    };
    const hide = await leftoverVideoIdsToHide({
      creationIds: ["still", "vg", "clip"],
      videosGroupId: null,
      keepIds: ["still"],
      lookup: async (id) => catalog[id] ?? null,
    });
    expect(hide.sort()).toEqual(["clip", "vg"]);
  });

  it("hides a loose video tile and keeps an explicit videoId", async () => {
    const catalog: Record<string, Creation> = {
      still: row("still"),
      old: row("old", { mediaType: "video" }),
      keep: row("keep", { mediaType: "video" }),
    };
    const hideOld = await leftoverVideoIdsToHide({
      creationIds: ["still", "old"],
      keepIds: ["still"],
      lookup: async (id) => catalog[id] ?? null,
    });
    expect(hideOld).toEqual(["old"]);
    const hideNone = await leftoverVideoIdsToHide({
      creationIds: ["still", "keep"],
      keepIds: ["still", "keep"],
      lookup: async (id) => catalog[id] ?? null,
    });
    expect(hideNone).toEqual([]);
  });
});
