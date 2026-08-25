import { describe, expect, it } from "vitest";
import type { Creation } from "../library/types";
import {
  bucketDesktopCabinets,
  coverSourceIdFromRemoteGroup,
  expectedMembersAfterAppend,
  findCabinetCandidatesInCatalog,
  findUnstampedCabinetDuplicates,
  idsForGroupApiCall,
  memberIdsFromRemoteGroup,
  newIdsToAppendToGroup,
  pickCabinetKeeper,
  remainingMembersAfterRemoval,
  siblingProjectCabinetCoverIds,
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

describe("newIdsToAppendToGroup", () => {
  it("drops the cover and already-filed members", () => {
    expect(
      newIdsToAppendToGroup("18842", ["18841", "18845"], ["18842", "18845", "18846"]),
    ).toEqual(["18846"]);
  });

  it("is empty when every candidate is already in the group", () => {
    expect(newIdsToAppendToGroup("18842", ["25019"], ["25019"])).toEqual([]);
  });

  it("keeps all candidates when starting a new group", () => {
    expect(newIdsToAppendToGroup(null, [], ["10", "11"])).toEqual(["10", "11"]);
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

describe("siblingProjectCabinetCoverIds", () => {
  it("returns other Images containers in the same project folder", () => {
    const keeper = fakeCreation({
      id: "25892",
      title: "Parascene Desktop · The More I Know · Images",
      remoteJson: JSON.stringify({
        meta: {
          group: { kind: "group_creations", source_creation_ids: [1] },
        },
      }),
    });
    const stale = fakeCreation({
      id: "25650",
      title: "Parascene Desktop · The More I Know · Images",
      remoteJson: JSON.stringify({
        meta: {
          group: { kind: "group_creations", source_creation_ids: [2] },
        },
      }),
    });
    const pack = fakeCreation({
      id: "24485",
      title: "Look pack",
      remoteJson: JSON.stringify({
        meta: {
          group: { kind: "group_creations", source_creation_ids: [9] },
        },
      }),
    });
    expect(
      siblingProjectCabinetCoverIds({
        keeperId: "25892",
        kind: "images",
        projectId: "p1",
        projectTitle: "The More I Know",
        folderMemberIds: ["24485", "25650", "25742", "25892"],
        creationsById: {
          "25892": keeper,
          "25650": stale,
          "24485": pack,
        },
      }),
    ).toEqual(["25650"]);
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

  it("does not recover party-name-only covers when a project id is known", () => {
    const partyOnly = fakeCreation({
      id: "img-party",
      title: "Parascene Desktop · Untitled project · Images",
      remoteJson: JSON.stringify({
        meta: {
          group: {
            kind: "group_creations",
            source_creation_ids: [5],
          },
        },
      }),
    });
    const stampedOther = fakeCreation({
      id: "img-other",
      title: "Parascene Desktop · Untitled project · Images",
      remoteJson: JSON.stringify({
        meta: {
          group: {
            kind: "group_creations",
            source_creation_ids: [6],
          },
          desktop: {
            role: "project_images",
            client: "parascene-desktop",
            projectId: "proj-old",
          },
        },
      }),
    });
    const found = findCabinetCandidatesInCatalog([partyOnly, stampedOther], {
      role: "project_images",
      projectId: "proj-new",
      projectTitle: "Untitled project",
    });
    expect(found).toEqual([]);
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

  it("keeps party-name-only covers out of stamped projectId buckets", () => {
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
    const stampedBucket = buckets.find(
      (b) => b.role === "project_images" && b.projectId === "proj-1",
    );
    const titleBucket = buckets.find(
      (b) =>
        b.role === "project_images" &&
        b.projectKey === "title:Replicate" &&
        !b.projectId,
    );
    expect(stampedBucket?.coverIds).toEqual(["img-a"]);
    expect(titleBucket?.coverIds).toEqual(["img-party"]);
  });
});

describe("findUnstampedCabinetDuplicates", () => {
  const members = [19794, 19480, 19477];
  const keeper = fakeCreation({
    id: "18984",
    title: "Parascene Desktop · Untitled project · Videos",
    mediaType: "video",
    remoteJson: JSON.stringify({
      meta: {
        group: {
          kind: "group_creations",
          source_creation_ids: members,
        },
        desktop: {
          role: "project_videos",
          client: "parascene-desktop",
          projectId: "proj-fractal",
        },
      },
    }),
  });
  const unstamped = fakeCreation({
    id: "21550",
    title: "group/26_1786166956367_qnkdz6p.png",
    filename: "group/26_1786166956367_qnkdz6p.png",
    mediaType: "video",
    remoteJson: JSON.stringify({
      meta: {
        group: {
          kind: "group_creations",
          source_creation_ids: members,
        },
      },
    }),
  });
  const creativePack = fakeCreation({
    id: "pack",
    title: "My pack",
    filename: "group/pack.png",
    remoteJson: JSON.stringify({
      meta: {
        group: {
          kind: "group_creations",
          source_creation_ids: [1, 2, 3],
        },
      },
    }),
  });

  it("matches an unstamped regroup cover with the same members as a cabinet", () => {
    const found = findUnstampedCabinetDuplicates(
      [keeper, unstamped, creativePack],
      [
        {
          coverId: "18984",
          role: "project_videos",
          projectId: "proj-fractal",
          projectTitle: "fractal 0.4x dub",
        },
      ],
    );
    expect(found).toEqual([
      {
        orphanId: "21550",
        keeperId: "18984",
        role: "project_videos",
        projectId: "proj-fractal",
        projectTitle: "fractal 0.4x dub",
      },
    ]);
  });

  it("does not treat stamped cabinets or unrelated packs as duplicates", () => {
    const otherCabinet = fakeCreation({
      id: "18985",
      title: "Parascene Desktop · Other · Videos",
      remoteJson: JSON.stringify({
        meta: {
          group: {
            kind: "group_creations",
            source_creation_ids: members,
          },
          desktop: {
            role: "project_videos",
            client: "parascene-desktop",
            projectId: "proj-other",
          },
        },
      }),
    });
    const found = findUnstampedCabinetDuplicates(
      [keeper, otherCabinet, creativePack],
      [
        {
          coverId: "18984",
          role: "project_videos",
          projectId: "proj-fractal",
          projectTitle: "fractal 0.4x dub",
        },
      ],
    );
    expect(found).toEqual([]);
  });
});
