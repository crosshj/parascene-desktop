import { afterAll, describe, expect, it } from "vitest";
import {
  agentJson,
  invokeOk,
  loadAgentManifest,
  requireSignedIn,
  type AgentManifest,
} from "./agentClient";

type FolderCreateResult = {
  folderId?: string;
  title?: string;
  kind?: string;
  memberCount?: number;
  projectId?: string | null;
};

type ProjectCreateResult = {
  projectId?: string;
  folderId?: string | null;
  folderKind?: string | null;
};

type LibraryState = {
  folders?: Array<{
    id?: string;
    kind?: string;
    projectId?: string | null;
  }>;
};

const stamp = Date.now();
const folderTitle = `agent-test-folder-${stamp}`;
const projectTitle = `agent-test-folder-proj-${stamp}`;
let folderId = "";
let projectId = "";
let projectFolderId = "";

async function libraryState(agent: AgentManifest): Promise<LibraryState> {
  const { status, body } = await agentJson<LibraryState>(
    agent,
    "/agent/v1/state?scope=library",
  );
  expect(status).toBe(200);
  return body;
}

describe("agent folder", () => {
  afterAll(async () => {
    const agent = await loadAgentManifest();
    if (projectId) {
      await invokeOk(agent, "project.delete", { id: projectId }).catch(() => {});
    }
    if (folderId) {
      await invokeOk(agent, "folder.delete", { id: folderId }).catch(() => {});
    }
    if (projectFolderId) {
      await invokeOk(agent, "folder.delete", { id: projectFolderId }).catch(
        () => {},
      );
    }
  }, 90_000);

  it("creates a Library folder that is not a project folder", async () => {
    const agent = await loadAgentManifest();
    await requireSignedIn(agent);

    const folder = await invokeOk<FolderCreateResult>(agent, "folder.create", {
      title: folderTitle,
    });
    folderId = folder.folderId ?? "";
    expect(folderId).toBeTruthy();
    expect(folder.kind).toBe("regular");
    expect(folder.projectId).toBeFalsy();
    expect(folder.memberCount).toBe(0);

    const project = await invokeOk<ProjectCreateResult>(agent, "project.create", {
      title: projectTitle,
    });
    projectId = project.projectId ?? "";
    projectFolderId = project.folderId ?? "";
    expect(project.folderKind).toBe("project");
    expect(project.folderId).not.toBe(folderId);

    const library = await libraryState(agent);
    const libraryFolder = (library.folders ?? []).find(
      (row) => row.id === folderId,
    );
    const bound = (library.folders ?? []).find(
      (row) => row.id === project.folderId,
    );
    expect(libraryFolder?.kind).toBe("regular");
    expect(libraryFolder?.projectId).toBeFalsy();
    expect(bound?.kind).toBe("project");
    expect(bound?.projectId).toBe(projectId);
  });
});
