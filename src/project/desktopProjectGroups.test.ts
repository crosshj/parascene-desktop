import { describe, expect, it } from "vitest";
import {
  desktopProjectGroupMeta,
  desktopProjectGroupMetaFromCreation,
  desktopProjectGroupPartyName,
  isDesktopProjectGroup,
  isEditorProjectCabinet,
  isProjectCabinetId,
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
});
