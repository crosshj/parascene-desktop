import { describe, expect, it } from "vitest";
import type { Creation } from "../library/types";
import {
  bucketDesktopCabinets,
  coverSourceIdFromRemoteGroup,
  expectedMembersAfterAppend,
  findCabinetCandidatesInCatalog,
  idsForGroupApiCall,
  memberIdsFromRemoteGroup,
  pickCabinetKeeper,
  remainingMembersAfterRemoval,
  stillCandidateIdsFromGroup,
  withGroupMembership,
} from "./projectGroups";

function fakeCreation(
  partial: Partial<Creation> & Pick<Creation, "id" | "title">,
): Creation {
  return {
    mediaType: "image",
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: null,
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    downloadState: "remote",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2024-01-01T00:00:00.000Z",
    filename: "group/cover.json",
    description: null,
    color: null,
    status: "complete",
    width: null,
    height: null,
    aspectRatio: null,
    nsfw: false,
    isModeratedError: false,
    remoteJson: null,
    ...partial,
  };
}

describe("idsForGroupApiCall", () => {
  it("starts a new group from members only", () => {
    expect(idsForGroupApiCall(null, ["10", "11"])).toEqual(["10", "11"]);
  });

  it("appends with cover + new members only (not prior filed members)", () => {
    expect(idsForGroupApiCall("18842", ["18846"])).toEqual(["18842", "18846"]);
  });

  it("dedupes cover when it appears in new members", () => {
    expect(idsForGroupApiCall("18842", ["18842", "18846"])).toEqual([
      "18842",
      "18846",
    ]);
  });

  it("can rebuild a group with remaining members after removal", () => {
    expect(idsForGroupApiCall("18842", ["18845"])).toEqual(["18842", "18845"]);
  });

  it("refreshes an existing cover without re-sending filed members", () => {
    expect(idsForGroupApiCall("18842", [])).toEqual(["18842"]);
  });

  it("starts a fresh group from standalone survivors after ungroup", () => {
    expect(idsForGroupApiCall(null, ["18841", "18845"])).toEqual([
      "18841",
      "18845",
    ]);
  });
});

describe("expectedMembersAfterAppend", () => {
  it("merges prior + new for local catalog stamp", () => {
    expect(expectedMembersAfterAppend(["18841", "18845"], ["18846"])).toEqual([
      "18841",
      "18845",
      "18846",
    ]);
  });
});

describe("remainingMembersAfterRemoval", () => {
  it("drops removed ids and the cover id", () => {
    expect(
      remainingMembersAfterRemoval(
        ["18842", "18841", "18845"],
        ["18841"],
        "18842",
      ),
    ).toEqual(["18845"]);
  });

  it("returns empty when all members are removed", () => {
    expect(
      remainingMembersAfterRemoval(["18841", "18845"], ["18841", "18845"]),
    ).toEqual([]);
  });
});

describe("memberIdsFromRemoteGroup", () => {
  it("reads source_creation_ids from meta.group", () => {
    expect(
      memberIdsFromRemoteGroup({
        id: 18842,
        meta: {
          group: {
            kind: "group_creations",
            source_creation_ids: [18841, 18845],
          },
        },
      }),
    ).toEqual(["18841", "18845"]);
  });
});

describe("stillCandidateIdsFromGroup", () => {
  it("prefers cover_source_id then newest members first", () => {
    expect(
      stillCandidateIdsFromGroup({
        memberIds: ["18841", "18845", "18848"],
        coverSourceId: "18848",
      }),
    ).toEqual(["18848", "18845", "18841"]);
  });

  it("falls back to newest-first when cover is absent", () => {
    expect(
      stillCandidateIdsFromGroup({
        memberIds: ["18841", "18845", "18848"],
      }),
    ).toEqual(["18848", "18845", "18841"]);
  });
});

describe("coverSourceIdFromRemoteGroup", () => {
  it("reads cover_source_id", () => {
    expect(
      coverSourceIdFromRemoteGroup({
        id: 18842,
        meta: { group: { cover_source_id: 18848 } },
      }),
    ).toBe("18848");
  });
});

describe("withGroupMembership", () => {
  it("stamps source_creation_ids when detail response omitted them", () => {
    const patched = withGroupMembership(
      { id: 18842, meta: { args: { aspect_ratio: "9:16" } } },
      ["18841", "18845"],
      {
        kind: "images",
        projectId: "proj-1",
        projectTitle: "Freds Not Family",
      },
    );
    expect(patched.title).toContain("Images");
    expect(patched.meta).toMatchObject({
      desktop: { role: "project_images", client: "parascene-desktop" },
      group: {
        kind: "group_creations",
        source_creation_ids: [18841, 18845],
      },
      args: { aspect_ratio: "9:16" },
    });
  });
});

describe("pickCabinetKeeper", () => {
  it("prefers the stored id when present", () => {
    expect(
      pickCabinetKeeper(
        [
          { id: "a", memberCount: 2, createdAt: "2024-01-01" },
          { id: "b", memberCount: 10, createdAt: "2024-02-01" },
        ],
        "a",
      ),
    ).toBe("a");
  });

  it("picks most members then oldest when no preferred id", () => {
    expect(
      pickCabinetKeeper([
        { id: "small", memberCount: 2, createdAt: "2024-01-01" },
        { id: "big-new", memberCount: 10, createdAt: "2024-03-01" },
        { id: "big-old", memberCount: 10, createdAt: "2024-02-01" },
      ]),
    ).toBe("big-old");
  });

  it("returns null for an empty candidate list", () => {
    expect(pickCabinetKeeper([])).toBeNull();
  });
});

describe("findCabinetCandidatesInCatalog / bucketDesktopCabinets", () => {
  const imagesA = fakeCreation({
    id: "img-a",
    title: "Parascene Desktop · Replicate · Images",
    createdAt: "2024-01-01T00:00:00.000Z",
    remoteJson: JSON.stringify({
      meta: {
        group: {
          kind: "group_creations",
          source_creation_ids: [1, 2, 3],
        },
        desktop: {
          role: "project_images",
          client: "parascene-desktop",
          projectId: "proj-1",
        },
      },
    }),
  });
  const imagesB = fakeCreation({
    id: "img-b",
    title: "Parascene Desktop · Replicate · Images",
    createdAt: "2024-02-01T00:00:00.000Z",
    remoteJson: JSON.stringify({
      meta: {
        group: {
          kind: "group_creations",
          source_creation_ids: [4],
        },
        desktop: {
          role: "project_images",
          client: "parascene-desktop",
          projectId: "proj-1",
        },
      },
    }),
  });
  const videos = fakeCreation({
    id: "vid-a",
    title: "Parascene Desktop · Replicate · Videos",
    remoteJson: JSON.stringify({
      meta: {
        group: { kind: "group_creations", source_creation_ids: [9] },
        desktop: {
          role: "project_videos",
          client: "parascene-desktop",
          projectId: "proj-1",
        },
      },
    }),
  });
  const otherProject = fakeCreation({
    id: "other",
    title: "Parascene Desktop · Other · Images",
    remoteJson: JSON.stringify({
      meta: {
        group: { kind: "group_creations", source_creation_ids: [8] },
        desktop: {
          role: "project_images",
          client: "parascene-desktop",
          projectId: "proj-2",
        },
      },
    }),
  });

  it("finds matching cabinets for resolve recovery", () => {
    const found = findCabinetCandidatesInCatalog(
      [imagesA, imagesB, videos, otherProject],
      {
        role: "project_images",
        projectId: "proj-1",
        projectTitle: "Replicate",
      },
    );
    expect(found.map((c) => c.id).sort()).toEqual(["img-a", "img-b"]);
    expect(pickCabinetKeeper(found, null)).toBe("img-a");
  });

  it("buckets duplicates by project + role for dedupe", () => {
    const buckets = bucketDesktopCabinets([
      imagesA,
      imagesB,
      videos,
      otherProject,
    ]);
    const imagesBucket = buckets.find(
      (b) => b.role === "project_images" && b.projectId === "proj-1",
    );
    expect(imagesBucket?.coverIds.sort()).toEqual(["img-a", "img-b"]);
    const videosBucket = buckets.find(
      (b) => b.role === "project_videos" && b.projectId === "proj-1",
    );
    expect(videosBucket?.coverIds).toEqual(["vid-a"]);
  });

  it("merges party-name-only covers into stamped projectId buckets", () => {
    const partyOnly = fakeCreation({
      id: "img-party",
      title: "Parascene Desktop · Replicate · Images",
      remoteJson: JSON.stringify({
        meta: {
          group: {
            kind: "group_creations",
            source_creation_ids: [5],
          },
        },
      }),
    });
    const buckets = bucketDesktopCabinets([imagesA, partyOnly]);
    const imagesBucket = buckets.find(
      (b) => b.role === "project_images" && b.projectId === "proj-1",
    );
    expect(imagesBucket?.coverIds.sort()).toEqual(["img-a", "img-party"]);
  });
});
