import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  agentInvoke,
  invokeOk,
  loadAgentManifest,
  requireSignedIn,
} from "./agentClient";
import {
  expectCloudHasCreation,
  expectCloudMissing,
} from "./cloudIdentity";
import { sweepTestCreations } from "./teardown";
import { AGENT_TEST_SPEECH_PATH } from "../src/fixtures/agentTestSpeech";

type ProjectCreateResult = {
  projectId?: string;
  folderId?: string | null;
};

type GenerateResult = {
  creationId?: string;
  projectId?: string;
  imagesGroupId?: string | null;
};

type ImportResult = {
  creations?: Array<{ id: string; localPath?: string | null }>;
};

type LookupRow = {
  id: string;
  localOnly?: boolean;
  origin?: string;
  localPath?: string | null;
  cabinet?: string | null;
  inProject?: boolean;
};

type LookupResult = {
  found?: LookupRow[];
};

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const stamp = Date.now();
const TITLE_PREFIX = "agent-test-assets-";
const title = `${TITLE_PREFIX}${stamp}`;
const prompt = "a blue sphere on a gray floor, photorealistic, no text";
const localPath = join(tmpdir(), `${TITLE_PREFIX}${stamp}.png`);
writeFileSync(localPath, TINY_PNG);

let projectId = "";
let folderId = "";
let stillToRemove = "";
let stillToDelete = "";
let imagesGroupId = "";
let deleteGroupId = "";
let localOnlyId = "";
let audioId = "";

async function lookupRow(
  agent: Parameters<typeof invokeOk>[0],
  id: string,
): Promise<LookupRow | undefined> {
  const looked = await invokeOk<LookupResult>(agent, "library.lookup", { id });
  return looked.found?.[0];
}

describe("agent assets remove and delete", () => {
  afterAll(async () => {
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, {
      ids: [
        stillToRemove,
        stillToDelete,
        imagesGroupId,
        deleteGroupId,
        localOnlyId,
        audioId,
      ],
      titleContains: [TITLE_PREFIX],
      pathContains: [TITLE_PREFIX],
      promptContains: [prompt],
      projectId,
      folderId,
    });
  }, 300_000);

  it(
    "Removes the last Images still from the project and Deletes a Parascene still plus a local-only import",
    async () => {
      const agent = await loadAgentManifest();
      await requireSignedIn(agent);
      expect(existsSync(localPath)).toBe(true);
      expect(existsSync(AGENT_TEST_SPEECH_PATH)).toBe(true);

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
      stillToRemove = generated.creationId ?? "";
      imagesGroupId = generated.imagesGroupId ?? "";
      expect(stillToRemove).toBeTruthy();

      const importedStill = await invokeOk<ImportResult>(
        agent,
        "library.import",
        { projectId, paths: [localPath] },
      );
      localOnlyId = importedStill.creations?.[0]?.id ?? "";
      expect(localOnlyId).toBeTruthy();

      const importedAudio = await invokeOk<ImportResult>(
        agent,
        "library.import",
        { projectId, paths: [AGENT_TEST_SPEECH_PATH] },
      );
      audioId = importedAudio.creations?.[0]?.id ?? "";
      expect(audioId).toBeTruthy();

      await invokeOk(agent, "generation.a2v", {
        projectId,
        stillId: stillToRemove,
        audioId,
        generate: false,
      });

      const blockedRemove = await agentInvoke(agent, "project.assets.remove", {
        id: audioId,
        projectId,
      });
      expect(blockedRemove.body.ok).toBe(false);
      expect(blockedRemove.body.error ?? "").toMatch(/timeline/i);

      const blockedDelete = await agentInvoke(agent, "project.assets.delete", {
        id: audioId,
        projectId,
      });
      expect(blockedDelete.body.ok).toBe(false);
      expect(blockedDelete.body.error ?? "").toMatch(/timeline/i);

      const beforeRemove = await lookupRow(agent, stillToRemove);
      expect(beforeRemove?.origin).toBe("parascene");
      if (imagesGroupId) {
        expect(beforeRemove?.cabinet).toBe("images");
      }

      await invokeOk(agent, "project.assets.remove", {
        id: stillToRemove,
        projectId,
      });

      const afterRemove = await lookupRow(agent, stillToRemove);
      expect(afterRemove?.id).toBe(stillToRemove);
      expect(afterRemove?.origin).toBe("parascene");
      expect(afterRemove?.localOnly).toBe(false);
      expect(afterRemove?.inProject).toBe(false);
      expect(afterRemove?.cabinet).toBeNull();
      expect(afterRemove?.localPath).toBeTruthy();
      expect(existsSync(afterRemove?.localPath ?? "")).toBe(true);

      await expectCloudHasCreation(agent, stillToRemove);

      if (imagesGroupId && imagesGroupId !== stillToRemove) {
        await expectCloudMissing(agent, imagesGroupId);
      }

      await invokeOk(agent, "project.close");
      await invokeOk(agent, "project.open", { id: projectId, mode: "editor" });

      const afterRemount = await lookupRow(agent, stillToRemove);
      expect(afterRemount?.id).toBe(stillToRemove);
      expect(afterRemount?.inProject).toBe(false);
      expect(afterRemount?.cabinet).toBeNull();
      expect(afterRemount?.origin).toBe("parascene");

      const toDelete = await invokeOk<GenerateResult>(agent, "generation.start", {
        projectId,
        prompt: `${prompt}, slightly different lighting`,
      });
      stillToDelete = toDelete.creationId ?? "";
      deleteGroupId = toDelete.imagesGroupId ?? "";
      expect(stillToDelete).toBeTruthy();

      await invokeOk(agent, "project.assets.delete", {
        id: stillToDelete,
        projectId,
      });

      const deletedLocal = await invokeOk<LookupResult>(agent, "library.lookup", {
        id: stillToDelete,
      });
      expect(deletedLocal.found ?? []).toHaveLength(0);
      await expectCloudMissing(agent, stillToDelete);

      const localOnlyBefore = await lookupRow(agent, localOnlyId);
      expect(localOnlyBefore?.localOnly).toBe(true);
      expect(localOnlyBefore?.inProject).toBe(true);

      await invokeOk(agent, "project.assets.delete", {
        id: localOnlyId,
        projectId,
      });

      const localOnlyAfter = await invokeOk<LookupResult>(
        agent,
        "library.lookup",
        { id: localOnlyId },
      );
      expect(localOnlyAfter.found ?? []).toHaveLength(0);
      await expectCloudMissing(agent, localOnlyId);

      await invokeOk(agent, "sync.start");

      const afterSyncDeleted = await invokeOk<LookupResult>(
        agent,
        "library.lookup",
        { ids: [stillToDelete, localOnlyId] },
      );
      expect(afterSyncDeleted.found ?? []).toHaveLength(0);

      const removedStillAfterSync = await lookupRow(agent, stillToRemove);
      expect(removedStillAfterSync?.id).toBe(stillToRemove);
      expect(removedStillAfterSync?.inProject).toBe(false);
    },
    24 * 60_000,
  );
});
