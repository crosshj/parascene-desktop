import { afterAll, describe, expect, it } from "vitest";
import {
  invokeOk,
  loadAgentManifest,
  requireSignedIn,
} from "./agentClient";

type ProjectCreateResult = {
  projectId?: string;
  folderId?: string | null;
};

type GenerateResult = {
  creationId?: string;
  projectId?: string;
  imagesGroupId?: string | null;
};

const stamp = Date.now();
const title = `agent-test-gen-${stamp}`;
let projectId = "";
let folderId = "";
let creationId = "";
let imagesGroupId = "";

describe("agent generation", () => {
  afterAll(async () => {
    const agent = await loadAgentManifest();
    const ids = [creationId, imagesGroupId].filter(Boolean);
    if (ids.length) {
      await invokeOk(agent, "cloud.delete", { ids }).catch(() => {});
    }
    if (projectId) {
      await invokeOk(agent, "project.delete", { id: projectId }).catch(() => {});
    }
    if (folderId) {
      await invokeOk(agent, "folder.delete", { id: folderId }).catch(() => {});
    }
  }, 90_000);

  it(
    "generates a Parascene still in a project and tears it down",
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
        {
          projectId,
          prompt: "a beautiful frog in a princess dress with a tiny, little crown",
          model: "checkpoints/1.5/lofi_V2pre.safetensors",
        },
      );
      creationId = generated.creationId ?? "";
      imagesGroupId = generated.imagesGroupId ?? "";
      expect(creationId).toBeTruthy();
      expect(generated.projectId).toBe(projectId);

      await invokeOk(agent, "cloud.delete", {
        id: creationId,
        imagesGroupId,
      });
      const leftover = await invokeOk<{ found?: Array<{ id: string }> }>(
        agent,
        "library.lookup",
        { id: creationId, imagesGroupId },
      );
      expect(leftover.found ?? []).toEqual([]);
      creationId = "";
      imagesGroupId = "";
    },
    12 * 60_000,
  );
});
