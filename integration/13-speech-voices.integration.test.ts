import { existsSync, statSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { invokeOk, loadAgentManifest, requireSignedIn } from "./agentClient";
import { captureHelpScreen, publishHelpAudio, syncHelpFileList } from "./helpArtifacts";
import { sweepTestCreations } from "./teardown";
import {
  AGENT_TEST_SPEECH_VOICES_CUSTOM_ID,
  AGENT_TEST_SPEECH_VOICES_CUSTOM_SCREEN,
  AGENT_TEST_SPEECH_VOICES_GEMINI_ID,
  AGENT_TEST_SPEECH_VOICES_GEMINI_STYLE_SCREEN,
  AGENT_TEST_SPEECH_VOICES_LINE,
  AGENT_TEST_SPEECH_VOICES_MARKUP_SCREEN,
  AGENT_TEST_SPEECH_VOICES_PAUSE,
  AGENT_TEST_SPEECH_VOICES_PICKER_ID,
  AGENT_TEST_SPEECH_VOICES_PROJECT_PREFIX,
  AGENT_TEST_SPEECH_VOICES_STYLE,
  AGENT_TEST_GEMINI_SPEECH_MODEL,
  AGENT_TEST_MINIMAX_SPEECH_MODEL,
  speechVoiceClips,
  speechVoiceDest,
  speechVoiceInvokeArgs,
  speechVoicePromptContains,
  writeSpeechVoicesHelpPage,
} from "../src/fixtures/agentTestSpeechVoices";

type ProjectCreateResult = {
  projectId?: string;
  folderId?: string | null;
};

type AudioGenerateResult = {
  creationId?: string;
  projectId?: string;
  localPath?: string | null;
  staged?: boolean;
};

const stamp = Date.now();
const title = `${AGENT_TEST_SPEECH_VOICES_PROJECT_PREFIX}${stamp}`;
let projectId = "";
let folderId = "";
const createdIds: string[] = [];

function sweepThisSuite() {
  return {
    ids: createdIds,
    titleContains: [AGENT_TEST_SPEECH_VOICES_PROJECT_PREFIX],
    promptContains: speechVoicePromptContains(),
    projectId,
    folderId,
  };
}

describe("agent speech voices", () => {
  beforeAll(async () => {
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, sweepThisSuite());
  }, 120_000);

  afterAll(async () => {
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, sweepThisSuite());
  }, 180_000);

  it(
    "stages Custom and markup forms, speaks every English FAQ id, and publishes Help clips",
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

      const customForm = await invokeOk<AudioGenerateResult>(agent, "generation.audio", {
        projectId,
        intent: "text_to_speech",
        prompt: AGENT_TEST_SPEECH_VOICES_LINE,
        model: AGENT_TEST_MINIMAX_SPEECH_MODEL,
        voice: AGENT_TEST_SPEECH_VOICES_CUSTOM_ID,
        generate: false,
      });
      expect(customForm.staged).toBe(true);
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_SPEECH_VOICES_CUSTOM_SCREEN, {
        keepUi: true,
      });

      const markupForm = await invokeOk<AudioGenerateResult>(agent, "generation.audio", {
        projectId,
        intent: "text_to_speech",
        prompt: AGENT_TEST_SPEECH_VOICES_PAUSE,
        model: AGENT_TEST_MINIMAX_SPEECH_MODEL,
        voice: AGENT_TEST_SPEECH_VOICES_PICKER_ID,
        emotion: "happy",
        generate: false,
      });
      expect(markupForm.staged).toBe(true);
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_SPEECH_VOICES_MARKUP_SCREEN, {
        keepUi: true,
      });

      const styleForm = await invokeOk<AudioGenerateResult>(agent, "generation.audio", {
        projectId,
        intent: "text_to_speech",
        prompt: AGENT_TEST_SPEECH_VOICES_LINE,
        model: AGENT_TEST_GEMINI_SPEECH_MODEL,
        voice: AGENT_TEST_SPEECH_VOICES_GEMINI_ID,
        style: AGENT_TEST_SPEECH_VOICES_STYLE,
        generate: false,
      });
      expect(styleForm.staged).toBe(true);
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_SPEECH_VOICES_GEMINI_STYLE_SCREEN, {
        keepUi: true,
      });

      const clips = speechVoiceClips();
      expect(clips.length).toBeGreaterThan(50);
      const failures: string[] = [];

      for (const clip of clips) {
        const dest = speechVoiceDest(clip);
        try {
          if (existsSync(dest) && statSync(dest).size > 1000) continue;
          const generated = await invokeOk<AudioGenerateResult>(
            agent,
            "generation.audio",
            speechVoiceInvokeArgs(clip, projectId),
          );
          if (generated.creationId) createdIds.push(generated.creationId);
          expect(generated.localPath).toBeTruthy();
          const published = await publishHelpAudio(generated.localPath!, dest);
          expect(statSync(published).size).toBeGreaterThan(1000);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${clip.label} (${clip.voice}): ${message}`);
        }
      }

      writeSpeechVoicesHelpPage();
      await syncHelpFileList();
      expect(failures, failures.join("\n")).toEqual([]);
    },
    3 * 60 * 60_000,
  );
});
