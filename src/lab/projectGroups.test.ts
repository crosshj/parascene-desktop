import { describe, expect, it } from "vitest";
import {
  coverSourceIdFromRemoteGroup,
  expectedMembersAfterAppend,
  idsForGroupApiCall,
  memberIdsFromRemoteGroup,
  stillCandidateIdsFromGroup,
  withGroupMembership,
} from "./projectGroups";

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
