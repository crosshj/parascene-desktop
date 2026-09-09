import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { invokeOk, loadAgentManifest, requireSignedIn } from "./agentClient";
import { sweepTestCreations } from "./teardown";

type ProjectCreateResult = {
  projectId?: string;
  folderId?: string | null;
};

type GenerateResult = {
  creationId?: string;
  imagesGroupId?: string | null;
};

type LookupRow = {
  id: string;
  localPath?: string | null;
  localThumbPath?: string | null;
};

type LookupResult = {
  found?: LookupRow[];
};

const stamp = Date.now();
const TITLE_PREFIX = "agent-test-thumbs-";
const title = `${TITLE_PREFIX}${stamp}`;
const prompt = "a green cone on a white table, photorealistic, no text";

let projectId = "";
let folderId = "";
let creationId = "";
let imagesGroupId = "";

describe("agent thumbs and media rows", () => {
  afterAll(async () => {
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, {
      ids: [creationId, imagesGroupId],
      titleContains: [TITLE_PREFIX],
      promptContains: [prompt],
      projectId,
      folderId,
    });
  }, 300_000);

  it(
    "caches thumb and media for the still this run created",
    async () => {
      const agent = await loadAgentManifest();
      await requireSignedIn(agent);

      const created = await invokeOk<ProjectCreateResult>(
        agent,
        "project.create",
        { title },
      );
      projectId = created.projectId ?? "";
      folderId = created.folderId ?? "";
      expect(projectId).toBeTruthy();

      const generated = await invokeOk<GenerateResult>(
        agent,
        "generation.start",
        { projectId, prompt },
      );
      creationId = generated.creationId ?? "";
      imagesGroupId = generated.imagesGroupId ?? "";
      expect(creationId).toBeTruthy();

      await invokeOk(agent, "sync.thumbs");
      await invokeOk(agent, "sync.media");

      const looked = await invokeOk<LookupResult>(agent, "library.lookup", {
        id: creationId,
      });
      const row = looked.found?.[0];
      expect(row?.id).toBe(creationId);
      expect(row?.localPath).toBeTruthy();
      expect(existsSync(row?.localPath ?? "")).toBe(true);
      expect(row?.localThumbPath).toBeTruthy();
      expect(existsSync(row?.localThumbPath ?? "")).toBe(true);
    },
    12 * 60_000,
  );
});
