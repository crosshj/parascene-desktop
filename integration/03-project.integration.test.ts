import { afterAll, describe, expect, it } from "vitest";
import {
  AGENT_TEST_LIBRARY_PROJECT_DELETE_SCREEN,
  AGENT_TEST_LIBRARY_PROJECT_SCREEN,
} from "../src/fixtures/agentTestProject";
import {
  agentJson,
  invokeOk,
  loadAgentManifest,
  requireSignedIn,
  type AgentManifest,
} from "./agentClient";
import { captureHelpScreen, dismissHelpOverlays } from "./helpArtifacts";
import { sweepTestCreations } from "./teardown";
import { expectWwwMissing, expectWwwProjectCostume } from "./wwwCostume";

type ProjectCreateResult = {
  projectId?: string;
  title?: string;
  folderId?: string | null;
  folderKind?: string | null;
  containerVersion?: string | null;
  parasceneProjectId?: string | null;
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
const renamedTitle = `${title}-renamed`;
let projectId = "";
let folderId = "";
let parasceneProjectId = "";

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
  title?: string,
): Promise<ShellState> {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    const next = await shellState(agent);
    if (projectId === null && !next.openProjectId) return next;
    if (
      projectId &&
      next.openProjectId === projectId &&
      (title == null || next.openProjectTitle === title)
    ) {
      return next;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for open project to be ${projectId ?? "none"}${
      title ? ` titled ${title}` : ""
    }`,
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
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, {
      titleContains: ["agent-test-proj-"],
      projectId,
      folderId,
    });
  }, 90_000);

  it("creates a v2 project, opens it, and shows a Library Project tile", async () => {
    const agent = await loadAgentManifest();
    await requireSignedIn(agent);

    const created = await invokeOk<ProjectCreateResult>(agent, "project.create", {
      title,
    });
    projectId = created.projectId ?? "";
    folderId = created.folderId ?? "";
    parasceneProjectId = created.parasceneProjectId ?? "";
    expect(projectId).toBeTruthy();
    expect(created.containerVersion).toBe("v2");
    expect(parasceneProjectId).toBeTruthy();
    expect(created.folderId).toBe(`project-v2-${parasceneProjectId}`);
    expect(created.folderKind).toBe("project");

    await expectWwwProjectCostume(agent, parasceneProjectId, {
      title,
      empty: true,
    });

    const open = await waitForOpen(agent, projectId);
    expect(open.openProjectId).toBe(projectId);
    expect(open.openProjectTitle).toBe(title);
    expect(open.primaryTab).toBe("project");

    const library = await libraryState(agent);
    const bound = (library.folders ?? []).find(
      (folder) =>
        folder.projectId === projectId || folder.id === created.folderId,
    );
    expect(bound?.id).toBe(created.folderId);
    expect(bound?.kind).toBe("project");
    expect(bound?.title).toBe(title);
  });

  it("renames the project on Director, Library, and the website costume", async () => {
    const agent = await loadAgentManifest();
    await requireSignedIn(agent);
    expect(projectId).toBeTruthy();
    expect(parasceneProjectId).toBeTruthy();

    await invokeOk(agent, "project.rename", {
      id: projectId,
      title: renamedTitle,
    });
    const open = await waitForOpen(agent, projectId, renamedTitle);
    expect(open.openProjectTitle).toBe(renamedTitle);

    const library = await libraryState(agent);
    const bound = (library.folders ?? []).find(
      (folder) => folder.projectId === projectId || folder.id === folderId,
    );
    expect(bound?.title).toBe(renamedTitle);
    expect(bound?.id).toBe(folderId);

    await expectWwwProjectCostume(agent, parasceneProjectId, {
      title: renamedTitle,
      empty: true,
    });
  });

  it("closes and reopens the project", async () => {
    const agent = await loadAgentManifest();
    await requireSignedIn(agent);
    expect(projectId).toBeTruthy();

    await invokeOk(agent, "project.close");
    const closed = await waitForOpen(agent, null);
    expect(closed.openProjectId).toBeNull();

    await invokeOk(agent, "project.open", { id: projectId });
    const reopened = await waitForOpen(agent, projectId, renamedTitle);
    expect(reopened.openProjectId).toBe(projectId);
    expect(reopened.openProjectTitle).toBe(renamedTitle);
    expect(reopened.primaryTab).toBe("project");
  });

  it("wipes from the Library Project tile and writes the Help delete shots", async () => {
    const agent = await loadAgentManifest();
    await requireSignedIn(agent);
    expect(projectId).toBeTruthy();
    expect(folderId).toBeTruthy();
    expect(parasceneProjectId).toBeTruthy();

    await invokeOk(agent, "project.rename", {
      id: projectId,
      title: "Untitled project",
    });
    await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
    await invokeOk(agent, "project.close");
    await invokeOk(agent, "shell.show", {
      tab: "library",
      folderId,
    });
    await captureHelpScreen(AGENT_TEST_LIBRARY_PROJECT_SCREEN);

    await invokeOk(agent, "project.delete", {
      id: projectId,
      confirm: true,
    });
    await captureHelpScreen(AGENT_TEST_LIBRARY_PROJECT_DELETE_SCREEN, {
      keepUi: true,
    });
    await dismissHelpOverlays();

    await invokeOk(agent, "project.delete", { id: projectId });
    projectId = "";
    await expectWwwMissing(agent, parasceneProjectId);
  }, 90_000);
});
