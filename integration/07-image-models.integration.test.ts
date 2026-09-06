import { existsSync, statSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { invokeOk, loadAgentManifest, requireSignedIn } from "./agentClient";
import { publishHelpStill, syncHelpFileList } from "./helpArtifacts";
import { sweepTestCreations } from "./teardown";
import {
  AGENT_TEST_IMAGE_MODELS_ASPECT,
  AGENT_TEST_IMAGE_MODELS_PROMPT,
  agentTestImageModels,
  imageModelGenerateTweak,
  imageModelStillPath,
  isInputImageEditModel,
  isSharedGrokStill,
  writeImageModelsHelpPage,
} from "../src/fixtures/agentTestImageModels";

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

const stamp = Date.now();
const title = `agent-test-models-${stamp}`;
let projectId = "";
let folderId = "";
const createdIds: string[] = [];

describe("agent image models", () => {
  afterAll(async () => {
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, {
      ids: createdIds,
      titleContains: ["agent-test-models-"],
      projectId,
      folderId,
    });
  }, 180_000);

  it(
    "runs the shared goblin prompt on every Parascene Text to Image model and publishes Help stills",
    async () => {
      const agent = await loadAgentManifest();
      await requireSignedIn(agent);
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });

      const created = await invokeOk<ProjectCreateResult>(agent, "project.create", {
        title,
      });
      projectId = created.projectId ?? "";
      folderId = created.folderId ?? "";
      expect(projectId).toBeTruthy();

      const models = agentTestImageModels();
      expect(models.length).toBeGreaterThan(10);
      const failures: string[] = [];

      for (const model of models) {
        const dest = imageModelStillPath(model);
        try {
          if (isInputImageEditModel(model)) continue;
          if (isSharedGrokStill(model)) {
            expect(existsSync(dest)).toBe(true);
            expect(statSync(dest).size).toBeGreaterThan(10_000);
            continue;
          }
          if (existsSync(dest) && statSync(dest).size > 5_000) continue;
          const tweak = imageModelGenerateTweak(model);
          const startArgs: Record<string, unknown> = {
            projectId,
            prompt: tweak?.prompt ?? AGENT_TEST_IMAGE_MODELS_PROMPT,
            model: model.value,
          };
          if (tweak?.size) startArgs.size = tweak.size;
          else startArgs.aspectRatio = tweak?.aspectRatio ?? AGENT_TEST_IMAGE_MODELS_ASPECT;
          const generated = await invokeOk<GenerateResult>(agent, "generation.start", startArgs);
          if (generated.creationId) createdIds.push(generated.creationId);
          if (generated.imagesGroupId) createdIds.push(generated.imagesGroupId);
          expect(generated.localPath).toBeTruthy();
          await publishHelpStill(generated.localPath!, dest);
          expect(statSync(dest).size).toBeGreaterThan(5_000);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${model.label} (${model.value}): ${message}`);
        }
      }

      writeImageModelsHelpPage();
      await syncHelpFileList();
      expect(failures, failures.join("\n")).toEqual([]);
    },
    4 * 60 * 60_000,
  );
});
