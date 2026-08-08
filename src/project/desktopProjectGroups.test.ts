import { describe, expect, it } from "vitest";
import {
  desktopCabinetProjectKey,
  desktopProjectGroupMeta,
  desktopProjectGroupMetaFromCreation,
  desktopProjectGroupPartyName,
  identifyDesktopCabinet,
  isDesktopProjectGroup,
  isEditorProjectCabinet,
  isProjectCabinetId,
  matchesDesktopCabinetProject,
  parseDesktopCabinetPartyName,
  projectGroupKindForRole,
  recoverMissingCabinetIdsFromCreations,
} from "./desktopProjectGroups";

describe("desktopProjectGroups", () => {
  it("builds party names and meta for stamping", () => {
    expect(desktopProjectGroupPartyName("Fred", "project_images")).toBe(
      "Parascene Desktop · Fred · Images",
    );
    expect(desktopProjectGroupMeta({ role: "project_videos", projectId: "p1" })).toEqual({
      desktop: {
        role: "project_videos",
        client: "parascene-desktop",
        projectId: "p1",
      },
    });
  });

  it("parses desktop cabinet party names", () => {
    expect(parseDesktopCabinetPartyName("Parascene Desktop · Replicate · Images")).toEqual({
      projectTitle: "Replicate",
      role: "project_images",
    });
    expect(parseDesktopCabinetPartyName("Parascene Desktop · Fred Not Fam · Videos")).toEqual({
      projectTitle: "Fred Not Fam",
      role: "project_videos",
    });
    expect(parseDesktopCabinetPartyName("Ordinary group")).toBeNull();
  });

  it("identifies cabinets from meta and/or party name", () => {
    const stamped = {
      filename: "group/cover.json",
      title: "Parascene Desktop · Fred · Images",
      remoteJson: JSON.stringify({
        meta: {
          group: { kind: "group_creations" },
          desktop: {
            role: "project_images",
            client: "parascene-desktop",
            projectId: "abc",
          },
        },
      }),
    };
    expect(identifyDesktopCabinet(stamped)).toEqual({
      role: "project_images",
      projectId: "abc",
      projectTitle: "Fred",
    });

    const partyOnly = {
      filename: "group/cover.json",
      title: "Parascene Desktop · Replicate · Videos",
      remoteJson: JSON.stringify({
        meta: { group: { kind: "group_creations" } },
      }),
    };
    expect(identifyDesktopCabinet(partyOnly)).toEqual({
      role: "project_videos",
      projectTitle: "Replicate",
    });
  });

  it("matches cabinets by stamped project id when the caller has one", () => {
    expect(
      matchesDesktopCabinetProject(
        { role: "project_images", projectId: "abc", projectTitle: "Fred" },
        { role: "project_images", projectId: "abc", projectTitle: "Fred" },
      ),
    ).toBe(true);
    // Same default title must not steal another project's cabinet.
    expect(
      matchesDesktopCabinetProject(
        { role: "project_images", projectTitle: "Untitled project" },
        {
          role: "project_images",
          projectId: "other",
          projectTitle: "Untitled project",
        },
      ),
    ).toBe(false);
    expect(
      matchesDesktopCabinetProject(
        { role: "project_images", projectId: "abc" },
        { role: "project_images", projectId: "other", projectTitle: "Fred" },
      ),
    ).toBe(false);
    // Title match only when recovering with no project id.
    expect(
      matchesDesktopCabinetProject(
        { role: "project_images", projectTitle: "Replicate" },
        { role: "project_images", projectTitle: "Replicate" },
      ),
    ).toBe(true);
    expect(projectGroupKindForRole("project_videos")).toBe("videos");
    expect(desktopCabinetProjectKey({ projectId: "abc" })).toBe("id:abc");
    expect(desktopCabinetProjectKey({ projectTitle: "Fred" })).toBe("title:Fred");
  });

  it("detects stamped meta on a creation", () => {
    const creation = {
      filename: "group/cover.json",
      remoteJson: JSON.stringify({
        meta: {
          group: { kind: "group_creations" },
          desktop: {
            role: "project_images",
            client: "parascene-desktop",
            projectId: "abc",
          },
        },
      }),
    };
    expect(isDesktopProjectGroup(creation)).toBe(true);
    expect(desktopProjectGroupMetaFromCreation(creation)?.role).toBe(
      "project_images",
    );
  });

  it("honors project store ids even without meta", () => {
    expect(
      isProjectCabinetId("10", {
        imagesGroupId: "10",
        videosGroupId: "20",
      }),
    ).toBe(true);
    expect(
      isEditorProjectCabinet("20", undefined, {
        imagesGroupId: "10",
        videosGroupId: "20",
      }),
    ).toBe(true);
  });

  it("does not expand ordinary or foreign desktop groups as cabinets", () => {
    const stamped = {
      id: "99",
      filename: "group/cover.json",
      remoteJson: JSON.stringify({
        meta: {
          group: { kind: "group_creations" },
          desktop: {
            role: "project_images",
            client: "parascene-desktop",
            projectId: "other",
          },
        },
      }),
    };
    expect(isDesktopProjectGroup(stamped)).toBe(true);
    expect(
      isEditorProjectCabinet("99", stamped as never, {
        imagesGroupId: "10",
        videosGroupId: "20",
      }),
    ).toBe(false);
  });

  it("recovers missing store pointers from stamped covers in project assets", () => {
    const videos = {
      id: "21551",
      filename: "group/cover.json",
      title: "Parascene Desktop · Mothers Leave · Videos",
      createdAt: "2026-08-08T05:29:45.000Z",
      remoteJson: JSON.stringify({
        meta: {
          group: { kind: "group_creations", source_creation_ids: [21549, 21547] },
          desktop: {
            role: "project_videos",
            client: "parascene-desktop",
            projectId: "mothers",
          },
        },
      }),
    };
    const images = {
      id: "21546",
      filename: "group/cover.json",
      title: "Parascene Desktop · Untitled project · Images",
      createdAt: "2026-08-08T04:00:00.000Z",
      remoteJson: JSON.stringify({
        meta: {
          group: { kind: "group_creations", source_creation_ids: [1] },
          desktop: {
            role: "project_images",
            client: "parascene-desktop",
            projectId: "mothers",
          },
        },
      }),
    };
    const foreign = {
      id: "18984",
      filename: "group/cover.json",
      title: "Parascene Desktop · Untitled project · Videos",
      createdAt: "2026-08-01T00:00:00.000Z",
      remoteJson: JSON.stringify({
        meta: {
          group: { kind: "group_creations" },
          desktop: {
            role: "project_videos",
            client: "parascene-desktop",
            projectId: "fractal",
          },
        },
      }),
    };
    expect(
      recoverMissingCabinetIdsFromCreations({
        projectId: "mothers",
        imagesGroupId: null,
        videosGroupId: null,
        creations: [videos, images, foreign],
      }),
    ).toEqual({ imagesGroupId: "21546", videosGroupId: "21551" });
    expect(
      recoverMissingCabinetIdsFromCreations({
        projectId: "mothers",
        imagesGroupId: "21546",
        videosGroupId: "21551",
        creations: [videos, images],
      }),
    ).toEqual({});
  });
});
