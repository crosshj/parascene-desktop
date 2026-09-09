import { existsSync, statSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { invokeOk, loadAgentManifest, requireSignedIn } from "./agentClient";
import {
  expectCloudHasCreation,
  expectCloudMissing,
} from "./cloudIdentity";
import { sweepTestCreations } from "./teardown";

type ProjectCreateResult = {
  projectId?: string;
  folderId?: string | null;
};

type GenerateResult = {
  creationId?: string;
  projectId?: string;
  localPath?: string | null;
  imagesGroupId?: string | null;
};

type LookupRow = {
  id: string;
  localOnly?: boolean;
  origin?: string;
  localPath?: string | null;
  cabinet?: string | null;
};

type LookupResult = {
  found?: LookupRow[];
};

const stamp = Date.now();
const TITLE_PREFIX = "agent-test-identity-";
const title = `${TITLE_PREFIX}${stamp}`;
const prompt = "a red cube on a white table, photorealistic, no text";

let projectId = "";
let folderId = "";
let creationId = "";
let imagesGroupId = "";
let localPath = "";

describe("agent identity", () => {
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
    "keeps one Parascene still the same object through generate, sync, delete project, and cloud delete",
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
      localPath = generated.localPath ?? "";
      expect(creationId).toBeTruthy();
      expect(generated.projectId).toBe(projectId);
      expect(localPath).toBeTruthy();
      expect(existsSync(localPath)).toBe(true);
      expect(statSync(localPath).size).toBeGreaterThan(1000);

      const afterGenerate = await invokeOk<LookupResult>(
        agent,
        "library.lookup",
        { id: creationId },
      );
      const localRow = afterGenerate.found?.[0];
      expect(afterGenerate.found).toHaveLength(1);
      expect(localRow?.id).toBe(creationId);
      expect(localRow?.localOnly).toBe(false);
      expect(localRow?.origin).toBe("parascene");
      expect(localRow?.localPath).toBeTruthy();

      await expectCloudHasCreation(agent, creationId, imagesGroupId);

      await invokeOk(agent, "sync.start");

      const afterSync = await invokeOk<LookupResult>(agent, "library.lookup", {
        id: creationId,
      });
      expect(afterSync.found).toHaveLength(1);
      expect(afterSync.found?.[0]?.id).toBe(creationId);
      expect(afterSync.found?.[0]?.localOnly).toBe(false);
      expect(afterSync.found?.[0]?.origin).toBe("parascene");

      await expectCloudHasCreation(agent, creationId, imagesGroupId);

      await invokeOk(agent, "project.delete", { id: projectId });
      projectId = "";

      const afterProjectDelete = await invokeOk<LookupResult>(
        agent,
        "library.lookup",
        { id: creationId },
      );
      expect(afterProjectDelete.found).toHaveLength(1);
      expect(afterProjectDelete.found?.[0]?.id).toBe(creationId);
      expect(afterProjectDelete.found?.[0]?.localPath).toBeTruthy();
      expect(existsSync(afterProjectDelete.found?.[0]?.localPath ?? "")).toBe(
        true,
      );

      await expectCloudHasCreation(agent, creationId, imagesGroupId);

      await invokeOk(agent, "cloud.delete", {
        ids: [creationId, imagesGroupId].filter(Boolean),
      });

      const afterCloudDelete = await invokeOk<LookupResult>(
        agent,
        "library.lookup",
        { id: creationId },
      );
      expect(afterCloudDelete.found ?? []).toHaveLength(0);

      await expectCloudMissing(agent, creationId);
      if (imagesGroupId && imagesGroupId !== creationId) {
        await expectCloudMissing(agent, imagesGroupId);
      }
    },
    12 * 60_000,
  );
});
