import { describe, expect, it } from "vitest";
import type { Creation } from "../library/types";
import {
  groupFieldsFromRemoteJson,
  inspectCabinetRole,
  inspectLocalRow,
  inspectRemoteRow,
  inspectWwwCreation,
  isCloudMissingStatus,
  statusFromCloudError,
} from "./inspectCreation";

function fakeCreation(
  partial: Partial<Creation> & Pick<Creation, "id" | "title">,
): Creation {
  return {
    mediaType: "image",
    remoteUrl: "https://example.com/1.png",
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: "/tmp/1.png",
    localThumbPath: "/tmp/1.thumb.png",
    published: false,
    publishedAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    downloadState: "local",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2024-01-01T00:00:00.000Z",
    filename: "1.png",
    description: null,
    color: null,
    status: "complete",
    width: null,
    height: null,
    aspectRatio: null,
    nsfw: false,
    isModeratedError: false,
    remoteJson: JSON.stringify({ id: partial.id, url: "https://example.com/1.png" }),
    ...partial,
  };
}

describe("inspectLocalRow", () => {
  it("marks a Parascene still and the project folder that files it", () => {
    const row = fakeCreation({ id: "18841", title: "Red cube" });
    const inspected = inspectLocalRow(
      row,
      [
        {
          id: "folder-1",
          title: "Show",
          kind: "project",
          projectId: "proj-1",
          memberIds: ["18842"],
        },
        {
          id: "folder-2",
          title: "Loose",
          kind: "regular",
          projectId: null,
          memberIds: ["18841"],
        },
      ],
      {
        imagesGroupId: "18842",
        videosGroupId: null,
        imagesMemberIds: ["18841"],
        videosMemberIds: [],
      },
    );
    expect(inspected.localOnly).toBe(false);
    expect(inspected.origin).toBe("parascene");
    expect(inspected.cabinet).toBe("images");
    expect(inspected.inProject).toBe(true);
    expect(inspected.folderIds).toEqual(["folder-2"]);
    expect(inspected.localPath).toBe("/tmp/1.png");
    expect(inspected.localThumbPath).toBe("/tmp/1.thumb.png");
  });

  it("marks a local-only import with no cabinet", () => {
    const row = fakeCreation({
      id: "local-9",
      title: "Disk still",
      remoteUrl: null,
      remoteJson: null,
      localPath: "/tmp/disk.png",
    });
    const inspected = inspectLocalRow(row, [], {
      imagesGroupId: null,
      videosGroupId: null,
      imagesMemberIds: [],
      videosMemberIds: [],
    });
    expect(inspected.localOnly).toBe(true);
    expect(inspected.origin).toBe("local");
    expect(inspected.cabinet).toBeNull();
    expect(inspected.inProject).toBe(false);
  });

  it("marks an Images cover as cabinet cover with member ids", () => {
    const remoteJson = JSON.stringify({
      filename: "group/cover.json",
      meta: {
        group: { kind: "group_creations", source_creation_ids: ["18841"] },
        desktop: { role: "project_images", client: "parascene-desktop" },
      },
    });
    const row = fakeCreation({
      id: "18842",
      title: "Images",
      filename: "group/cover.json",
      remoteJson,
    });
    const inspected = inspectLocalRow(row, [], {
      imagesGroupId: "18842",
      videosGroupId: null,
      imagesMemberIds: ["18841"],
      videosMemberIds: [],
    });
    expect(inspected.cabinet).toBe("cover");
    expect(inspected.groupKind).toBe("images");
    expect(inspected.memberIds).toEqual(["18841"]);
    expect(inspected.inProject).toBe(true);
  });
});

describe("groupFieldsFromRemoteJson", () => {
  it("reads a generic group when desktop role is missing", () => {
    const fields = groupFieldsFromRemoteJson(
      JSON.stringify({
        filename: "group/pack.json",
        meta: {
          group: { kind: "group_creations", source_creation_ids: ["1", "2"] },
        },
      }),
      "group/pack.json",
    );
    expect(fields.groupKind).toBe("group");
    expect(fields.memberIds).toEqual(["1", "2"]);
  });
});

describe("inspectCabinetRole", () => {
  it("returns cover for either cabinet pointer", () => {
    expect(
      inspectCabinetRole("vid-cover", {
        imagesGroupId: "img-cover",
        videosGroupId: "vid-cover",
        imagesMemberIds: ["a"],
        videosMemberIds: ["b"],
      }),
    ).toBe("cover");
  });
});

describe("inspectRemoteRow", () => {
  it("reads title, media type, and group members", () => {
    const inspected = inspectRemoteRow({
      id: 18841,
      title: "Red cube",
      media_type: "image",
      meta: {
        group: { kind: "group_creations", source_creation_ids: ["9"] },
      },
    });
    expect(inspected).toEqual({
      id: "18841",
      title: "Red cube",
      mediaType: "image",
      groupKind: "group",
      memberIds: ["9"],
    });
  });
});

describe("inspectWwwCreation", () => {
  it("reads an empty project costume and flags no raw items", () => {
    const inspected = inspectWwwCreation({
      id: 99,
      title: "Trip",
      published: false,
      media_type: "image",
      filename: "project/99.json",
      url: null,
      thumbnail_url: null,
      meta: {
        type: "project",
        group: {
          kind: "group_creations",
          badge: "project",
          cover_source_id: null,
          source_creations: [],
          supported: {
            publish: false,
            ungroup: false,
            carousel: false,
          },
        },
      },
    });
    expect(inspected.costumeApplied).toBe(true);
    expect(inspected.rawItemsLeaked).toBe(false);
    expect(inspected.groupKind).toBe("group_creations");
    expect(inspected.creationType).toBe("project");
    expect(inspected.badge).toBe("project");
    expect(inspected.published).toBe(false);
    expect(inspected.members).toEqual([]);
    expect(inspected.supported?.publish).toBe(false);
  });

  it("reads costume members, pixels, and audio type", () => {
    const inspected = inspectWwwCreation({
      id: 99,
      title: "Trip",
      published: false,
      media_type: "image",
      url: "https://cdn.example/cover.png",
      thumbnail_url: "https://cdn.example/cover.png",
      meta: {
        type: "project",
        group: {
          kind: "group_creations",
          badge: "project",
          cover_source_id: 11,
          source_creations: [
            {
              id: 11,
              file_path: "/api/images/created/219_11.png",
              meta: { media_type: "image" },
            },
            {
              id: 22,
              file_path: "/api/create/images/22/audio",
              meta: { media_type: "audio" },
            },
          ],
        },
      },
    });
    expect(inspected.members).toEqual([
      {
        id: "11",
        mediaType: "image",
        filePath: "/api/images/created/219_11.png",
      },
      {
        id: "22",
        mediaType: "audio",
        filePath: "/api/create/images/22/audio",
      },
    ]);
    expect(inspected.coverSourceId).toBe("11");
  });

  it("omits local pointers from raw items and flags a leak", () => {
    const inspected = inspectWwwCreation({
      id: 99,
      title: "Trip",
      published: false,
      items: [
        {
          pointer: { kind: "creation", creationId: 11 },
          cover: true,
          view: { mediaType: "image", url: "https://cdn.example/a.png" },
        },
        {
          pointer: { kind: "local", uri: "local://lib-1/only-here" },
          view: { mediaType: "image" },
        },
      ],
      meta: {
        type: "project",
        group: {
          kind: "group_v2",
          items: [
            { pointer: { kind: "creation", creationId: 11 } },
            { pointer: { kind: "local", uri: "local://lib-1/only-here" } },
          ],
        },
      },
    });
    expect(inspected.costumeApplied).toBe(false);
    expect(inspected.rawItemsLeaked).toBe(true);
    expect(inspected.members.map((member) => member.id)).toEqual(["11"]);
  });
});

describe("statusFromCloudError", () => {
  it("parses a 404 from get_creation", () => {
    expect(statusFromCloudError(new Error("get creation failed (404)"))).toBe(
      404,
    );
    expect(isCloudMissingStatus(404)).toBe(true);
    expect(isCloudMissingStatus(410)).toBe(true);
    expect(isCloudMissingStatus(500)).toBe(false);
  });

  it("treats a bare not-found message as 404", () => {
    expect(statusFromCloudError("Creation not found")).toBe(404);
  });

  it("treats a failed image fetch as missing", () => {
    expect(statusFromCloudError("Failed to fetch image")).toBe(404);
  });
});
