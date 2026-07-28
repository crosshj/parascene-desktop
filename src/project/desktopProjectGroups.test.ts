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

  it("matches cabinets to a project by id or title", () => {
    expect(
      matchesDesktopCabinetProject(
        { role: "project_images", projectId: "abc", projectTitle: "Fred" },
        { role: "project_images", projectId: "abc", projectTitle: "Fred" },
      ),
    ).toBe(true);
    expect(
      matchesDesktopCabinetProject(
        { role: "project_images", projectTitle: "Replicate" },
        { role: "project_images", projectId: "other", projectTitle: "Replicate" },
      ),
    ).toBe(true);
    expect(
      matchesDesktopCabinetProject(
        { role: "project_images", projectId: "abc" },
        { role: "project_images", projectId: "other", projectTitle: "Fred" },
      ),
    ).toBe(false);
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
});
