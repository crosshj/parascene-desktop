import { describe, expect, it } from "vitest";
import {
  collectCabinetMemberIdsFromCovers,
  isProjectOwnedCreation,
  projectCabinetCoverIdsInFolder,
} from "./projectOwnership";

describe("projectOwnership", () => {
  const project = {
    creationIds: ["cover-images", "cover-videos", "local-only"],
    imagesGroupId: "cover-images",
    videosGroupId: "cover-videos",
  };

  it("treats folder members as owned", () => {
    expect(isProjectOwnedCreation(project, "local-only")).toBe(true);
    expect(isProjectOwnedCreation(project, "cover-images")).toBe(true);
  });

  it("treats cabinet members as owned when cover is in the folder", () => {
    const cabinetMembers = new Set(["vid-1", "img-1"]);
    expect(isProjectOwnedCreation(project, "vid-1", cabinetMembers)).toBe(true);
    expect(isProjectOwnedCreation(project, "outside", cabinetMembers)).toBe(
      false,
    );
  });

  it("collects cabinet member ids only for covers filed in the folder", () => {
    const covers = [
      {
        id: "cover-videos",
        remoteJson: JSON.stringify({
          meta: {
            group: {
              kind: "group_creations",
              source_creation_ids: ["vid-1", "vid-2"],
            },
          },
        }),
      },
      {
        id: "orphan-cover",
        remoteJson: JSON.stringify({
          meta: {
            group: {
              kind: "group_creations",
              source_creation_ids: ["should-not"],
            },
          },
        }),
      },
    ];
    expect(projectCabinetCoverIdsInFolder(project)).toEqual([
      "cover-images",
      "cover-videos",
    ]);
    expect([
      ...collectCabinetMemberIdsFromCovers(project, covers),
    ]).toEqual(["vid-1", "vid-2"]);
  });
});
