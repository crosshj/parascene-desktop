import { describe, expect, it } from "vitest";
import {
  agentInvoke,
  agentJson,
  loadAgentManifest,
  type AgentManifest,
} from "./agentClient";

type AuthState = {
  status?: string;
  userId?: string | null;
};

type LibraryFolderRow = {
  id?: string;
  title?: string;
  kind?: string;
  memberCount?: number;
};

type LibraryState = {
  bound?: boolean;
  needsSync?: boolean;
  lastSyncAt?: string | null;
  total?: number;
  remote?: number;
  withThumb?: number;
  withMedia?: number;
  thumbsBytes?: number;
  mediaBytes?: number;
  missingThumbCacheable?: number;
  missingMediaCacheable?: number;
  folderCount?: number;
  folders?: LibraryFolderRow[];
};

type SyncStartResult = {
  added?: number;
  statusTotal?: number;
  lastSyncAt?: string | null;
};

async function requireSignedIn(agent: AgentManifest): Promise<void> {
  const { status, body } = await agentJson<AuthState>(
    agent,
    "/agent/v1/state?scope=auth",
  );
  expect(status).toBe(200);
  if (body.status !== "connected") {
    throw new Error(
      `Not signed in (auth.status=${body.status ?? "missing"}). Sign in on the running app, then retry.`,
    );
  }
}

async function libraryState(agent: AgentManifest): Promise<LibraryState> {
  const { status, body } = await agentJson<LibraryState>(
    agent,
    "/agent/v1/state?scope=library",
  );
  expect(status).toBe(200);
  expect(body.bound).toBe(true);
  return body;
}

describe("agent sync", () => {
  it("requires a signed-in session on the running app", async () => {
    const agent = await loadAgentManifest();
    await requireSignedIn(agent);
    const { body } = await agentJson<AuthState>(
      agent,
      "/agent/v1/state?scope=auth",
    );
    expect(body.userId).toBeTruthy();
  });

  it(
    "drops synced catalog then newest sync brings rows, previews, and media back",
    async () => {
      const agent = await loadAgentManifest();
      await requireSignedIn(agent);

      const cleared = await agentInvoke(agent, "library.clearLocal", {
        confirm: true,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.ok).toBe(true);

      const empty = await libraryState(agent);
      expect(empty.needsSync).toBe(true);
      expect(empty.lastSyncAt).toBeNull();
      expect(empty.remote).toBe(0);
      expect(empty.folderCount).toBe(0);

      const started = await agentInvoke<SyncStartResult>(agent, "sync.start");
      expect(started.status).toBe(200);
      expect(started.body.ok).toBe(true);
      const added = started.body.result?.added ?? 0;
      expect(
        added,
        "Newest sync added nothing — test account cloud library looks empty.",
      ).toBeGreaterThan(0);

      const afterCatalog = await libraryState(agent);
      expect(afterCatalog.needsSync).toBe(false);
      expect(afterCatalog.lastSyncAt).toBeTruthy();
      expect(afterCatalog.total ?? 0).toBeGreaterThan(0);

      const folders = await agentInvoke(agent, "sync.folders");
      expect(folders.status).toBe(200);
      expect(folders.body.ok).toBe(true);
      const afterFolders = await libraryState(agent);
      const filled = (afterFolders.folders ?? []).filter(
        (folder) => (folder.memberCount ?? 0) > 0,
      );
      expect(
        filled.length,
        "Folder sync left every folder empty — cloud folders may be missing members.",
      ).toBeGreaterThan(0);

      const thumbs = await agentInvoke(agent, "sync.thumbs");
      expect(thumbs.status).toBe(200);
      expect(thumbs.body.ok).toBe(true);
      const afterThumbs = await libraryState(agent);
      expect(afterThumbs.withThumb ?? 0).toBeGreaterThan(0);
      expect(afterThumbs.thumbsBytes ?? 0).toBeGreaterThan(0);

      const media = await agentInvoke(agent, "sync.media");
      expect(media.status).toBe(200);
      expect(media.body.ok).toBe(true);
      const afterMedia = await libraryState(agent);
      expect(afterMedia.withMedia ?? 0).toBeGreaterThan(0);
      expect(afterMedia.mediaBytes ?? 0).toBeGreaterThan(0);
    },
    20 * 60_000,
  );
});
