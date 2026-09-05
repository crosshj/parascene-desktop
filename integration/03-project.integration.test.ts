import { afterAll, describe, expect, it } from "vitest";
import {
  agentJson,
  invokeOk,
  loadAgentManifest,
  requireSignedIn,
  type AgentManifest,
} from "./agentClient";

type ProjectCreateResult = {
  projectId?: string;
  title?: string;
  folderId?: string | null;
  folderKind?: string | null;
};

type LibraryState = {
  folders?: Array<{
    id?: string;
    title?: string;
    kind?: string;
    projectId?: string | null;
    memberCount?: number;
  }>;
};

type ShellState = {
  openProjectId?: string | null;
  openProjectTitle?: string | null;
  primaryTab?: string;
};

const stamp = Date.now();
const title = `agent-test-proj-${stamp}`;
let projectId = "";
let folderId = "";

async function shellState(agent: AgentManifest): Promise<ShellState> {
  const { status, body } = await agentJson<ShellState>(
    agent,
    "/agent/v1/state?scope=shell",
  );
  expect(status).toBe(200);
  return body;
}

async function waitForOpen(
  agent: AgentManifest,
  projectId: string | null,
): Promise<ShellState> {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    const next = await shellState(agent);
    if (projectId === null && !next.openProjectId) return next;
    if (projectId && next.openProjectId === projectId) return next;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for open project to be ${projectId ?? "none"}`,
  );
}

async function libraryState(agent: AgentManifest): Promise<LibraryState> {
  const { status, body } = await agentJson<LibraryState>(
    agent,
    "/agent/v1/state?scope=library",
  );
  expect(status).toBe(200);
  return body;
}

describe("agent project", () => {
  afterAll(async () => {
    if (!projectId) return;
    const agent = await loadAgentManifest();
    await invokeOk(agent, "project.delete", { id: projectId }).catch(() => {});
    if (folderId) {
      await invokeOk(agent, "folder.delete", { id: folderId }).catch(() => {});
    }
  }, 90_000);

  it("creates a project, opens it, and binds a project folder", async () => {
    const agent = await loadAgentManifest();
    await requireSignedIn(agent);

    const created = await invokeOk<ProjectCreateResult>(agent, "project.create", {
      title,
    });
    projectId = created.projectId ?? "";
    folderId = created.folderId ?? "";
    expect(projectId).toBeTruthy();
    expect(created.folderId).toBeTruthy();
    expect(created.folderKind).toBe("project");

    const open = await waitForOpen(agent, projectId);
    expect(open.openProjectId).toBe(projectId);
    expect(open.openProjectTitle).toBe(title);
    expect(open.primaryTab).toBe("project");

    const library = await libraryState(agent);
    const bound = (library.folders ?? []).find(
      (folder) => folder.projectId === projectId,
    );
    expect(bound?.id).toBe(created.folderId);
    expect(bound?.kind).toBe("project");
  });

  it("closes and reopens the project", async () => {
    const agent = await loadAgentManifest();
    await requireSignedIn(agent);
    expect(projectId).toBeTruthy();

    await invokeOk(agent, "project.close");
    const closed = await waitForOpen(agent, null);
    expect(closed.openProjectId).toBeNull();

    await invokeOk(agent, "project.open", { id: projectId });
    const reopened = await waitForOpen(agent, projectId);
    expect(reopened.openProjectId).toBe(projectId);
    expect(reopened.primaryTab).toBe("project");
  });
});
