import { describe, expect, it } from "vitest";
import { leftoverProjectsFromState } from "./leftoverTestProjects";

describe("leftoverProjectsFromState", () => {
  it("collects leftover projects and folders by title prefix", () => {
    expect(
      leftoverProjectsFromState(["agent-test-audio-generate-"], {
        folders: [
          {
            id: "f1",
            title: "agent-test-audio-generate-1",
            projectId: "p1",
          },
          { id: "keep", title: "Travel", projectId: "other" },
        ],
        projects: [{ id: "p1", title: "agent-test-audio-generate-1" }],
        openProjectId: "p1",
        openProjectTitle: "agent-test-audio-generate-1",
      }),
    ).toEqual([{ projectId: "p1", folderId: "f1" }]);
  });

  it("keeps a matching regular folder when there is no project id", () => {
    expect(
      leftoverProjectsFromState(["agent-test-folder-"], {
        folders: [
          { id: "f2", title: "agent-test-folder-9", projectId: null },
        ],
      }),
    ).toEqual([{ folderId: "f2" }]);
  });

  it("does not treat a creation-file needle as a project title", () => {
    expect(
      leftoverProjectsFromState(["agent-test-speech"], {
        folders: [{ id: "f", title: "Night market", projectId: "p" }],
        projects: [{ id: "p", title: "Night market" }],
        openProjectId: "p",
        openProjectTitle: "Night market",
      }),
    ).toEqual([]);
  });
});
