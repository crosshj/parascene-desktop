import { existsSync, statSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  invokeOk,
  loadAgentManifest,
  requireSignedIn,
} from "./agentClient";
import { captureHelpScreen, publishHelpStill } from "./helpArtifacts";
import {
  clearGenerateJourney,
  JOURNEY_PROJECT_TITLE_PREFIX,
  readGenerateJourney,
  writeGenerateJourney,
} from "./journeyState";
import { sweepTestCreations } from "./teardown";
import {
  AGENT_TEST_EDITOR_GENERATE_PROMPT_SCREEN,
  AGENT_TEST_EDITOR_GENERATE_RESULT_SCREEN,
  AGENT_TEST_GENERATE_MODEL,
  AGENT_TEST_GENERATE_PROMPT,
  AGENT_TEST_GENERATE_STILL_PATH,
} from "../src/fixtures/agentTestGenerate";
import { AGENT_TEST_STILL_ASPECT } from "../src/fixtures/agentTestSpeech";

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
const title = `${JOURNEY_PROJECT_TITLE_PREFIX}${stamp}`;
let projectId = "";
let folderId = "";
let creationId = "";
let imagesGroupId = "";
let handedOff = false;

describe("agent generation", () => {
  afterAll(async () => {
    if (handedOff) return;
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, {
      ids: [creationId, imagesGroupId],
      titleContains: [JOURNEY_PROJECT_TITLE_PREFIX],
      promptContains: [AGENT_TEST_GENERATE_PROMPT],
      projectId,
      folderId,
    });
    clearGenerateJourney();
  }, 120_000);

  it(
    "fills the Text to Image form, generates the walkthrough still, and hands the same project to Audio to Video",
    async () => {
      const agent = await loadAgentManifest();
      await requireSignedIn(agent);
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });

      const previous = readGenerateJourney();
      if (previous?.projectId) {
        await sweepTestCreations(agent, {
          ids: [previous.stillId, previous.imagesGroupId],
          titleContains: [JOURNEY_PROJECT_TITLE_PREFIX],
          promptContains: [AGENT_TEST_GENERATE_PROMPT],
          projectId: previous.projectId,
          folderId: previous.folderId,
        });
        clearGenerateJourney();
      }

      const created = await invokeOk<ProjectCreateResult>(
        agent,
        "project.create",
        { title },
      );
      projectId = created.projectId ?? "";
      folderId = created.folderId ?? "";
      expect(projectId).toBeTruthy();

      await invokeOk(agent, "shell.show", {
        mode: "editor",
        panel: "newAsset",
        prompt: AGENT_TEST_GENERATE_PROMPT,
        model: AGENT_TEST_GENERATE_MODEL,
      });
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_EDITOR_GENERATE_PROMPT_SCREEN);

      const generated = await invokeOk<GenerateResult>(
        agent,
        "generation.start",
        {
          projectId,
          prompt: AGENT_TEST_GENERATE_PROMPT,
          model: AGENT_TEST_GENERATE_MODEL,
          aspectRatio: AGENT_TEST_STILL_ASPECT,
        },
      );
      creationId = generated.creationId ?? "";
      imagesGroupId = generated.imagesGroupId ?? "";
      expect(creationId).toBeTruthy();
      expect(generated.projectId).toBe(projectId);
      expect(generated.localPath).toBeTruthy();

      await invokeOk(agent, "shell.show", { mode: "editor" });
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_EDITOR_GENERATE_RESULT_SCREEN);
      const published = await publishHelpStill(
        generated.localPath!,
        AGENT_TEST_GENERATE_STILL_PATH,
      );
      expect(existsSync(published)).toBe(true);
      expect(statSync(published).size).toBeGreaterThan(10_000);
      expect(statSync(AGENT_TEST_EDITOR_GENERATE_PROMPT_SCREEN).size).toBeGreaterThan(
        50_000,
      );
      expect(statSync(AGENT_TEST_EDITOR_GENERATE_RESULT_SCREEN).size).toBeGreaterThan(
        50_000,
      );

      writeGenerateJourney({
        projectId,
        folderId,
        stillId: creationId,
        imagesGroupId,
        localPath: generated.localPath!,
        title,
      });
      handedOff = true;
    },
    12 * 60_000,
  );
});
