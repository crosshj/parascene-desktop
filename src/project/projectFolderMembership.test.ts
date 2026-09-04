import { describe, expect, it } from "vitest";
import type { LibraryFolder } from "../library/folderClient";
import { createStoredProject } from "./projectStore";
import {
  isMembershipMirrorStaleError,
  MEMBERSHIP_MIRROR_STALE_MESSAGE,
  mirrorProjectFolderMembership,
} from "./projectFolderMembership";

function folder(projectId: string, memberIds: string[]): LibraryFolder {
  return {
    id: `folder-${projectId}`,
    title: "Folder",
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memberIds,
    memberCount: memberIds.length,
    kind: "project",
    projectId,
  };
}

describe("projectFolderMembership", () => {
  it("copies native folder members onto the matching project", () => {
    const project = {
      ...createStoredProject("Live", ["old"]),
      lifecycle: "ready" as const,
    };
    const next = mirrorProjectFolderMembership(
      [project],
      [folder(project.id, ["cover"])],
    );
    expect(next[0].creationIds).toEqual(["cover"]);
  });

  it("leaves a project unchanged when membership already matches", () => {
    const project = {
      ...createStoredProject("Live", ["cover"]),
      lifecycle: "ready" as const,
    };
    const next = mirrorProjectFolderMembership(
      [project],
      [folder(project.id, ["cover"])],
    );
    expect(next[0]).toBe(project);
  });

  it("recognizes the native stale-barrier error", () => {
    expect(
      isMembershipMirrorStaleError(new Error(MEMBERSHIP_MIRROR_STALE_MESSAGE)),
    ).toBe(true);
    expect(isMembershipMirrorStaleError(new Error("unrelated"))).toBe(false);
  });
});
