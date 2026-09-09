import { existsSync, statSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { invokeOk, loadAgentManifest, requireSignedIn } from "./agentClient";
import { captureHelpScreen, publishHelpAudio } from "./helpArtifacts";
import { sweepTestCreations } from "./teardown";
import {
  AGENT_TEST_AUDIO_PROJECT_PREFIX,
  AGENT_TEST_EDITOR_AUDIO_GENERATE_PROMPT_SCREEN,
  AGENT_TEST_EDITOR_AUDIO_GENERATE_RESULT_SCREEN,
  AGENT_TEST_EDITOR_AUDIO_GENERATE_TIMELINE_SCREEN,
  AGENT_TEST_MUSIC_MODEL,
  AGENT_TEST_MUSIC_PATH,
  AGENT_TEST_MUSIC_PROMPT,
  AGENT_TEST_SPEAKER_ONE_LINE,
  AGENT_TEST_SPEAKER_ONE_PATH,
  AGENT_TEST_SPEAKER_ONE_VOICE,
  AGENT_TEST_SPEAKER_TWO_LINE,
  AGENT_TEST_SPEAKER_TWO_PATH,
  AGENT_TEST_SPEAKER_TWO_VOICE,
  AGENT_TEST_SPEECH_MODEL,
} from "../src/fixtures/agentTestAudioGenerate";

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
const title = `${AGENT_TEST_AUDIO_PROJECT_PREFIX}${stamp}`;
let projectId = "";
let folderId = "";
let speakerOneId = "";
let speakerTwoId = "";
let musicId = "";

describe("agent audio generate", () => {
  afterAll(async () => {
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, {
      ids: [speakerOneId, speakerTwoId, musicId],
      titleContains: [AGENT_TEST_AUDIO_PROJECT_PREFIX],
      promptContains: [
        AGENT_TEST_SPEAKER_ONE_LINE,
        AGENT_TEST_SPEAKER_TWO_LINE,
        AGENT_TEST_MUSIC_PROMPT,
      ],
      projectId,
      folderId,
    });
  }, 120_000);

  it(
    "creates a project with two speakers and background music on A1/A2",
    async () => {
      const agent = await loadAgentManifest();
      await requireSignedIn(agent);
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });

      const created = await invokeOk<ProjectCreateResult>(
        agent,
        "project.create",
        { title },
      );
      projectId = created.projectId ?? "";
      folderId = created.folderId ?? "";
      expect(projectId).toBeTruthy();

      const form = await invokeOk<AudioGenerateResult>(agent, "generation.audio", {
        projectId,
        intent: "text_to_speech",
        prompt: AGENT_TEST_SPEAKER_ONE_LINE,
        model: AGENT_TEST_SPEECH_MODEL,
        voice: AGENT_TEST_SPEAKER_ONE_VOICE,
        generate: false,
      });
      expect(form.staged).toBe(true);
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_EDITOR_AUDIO_GENERATE_PROMPT_SCREEN);

      const speakerOne = await invokeOk<AudioGenerateResult>(
        agent,
        "generation.audio",
        {
          projectId,
          intent: "text_to_speech",
          prompt: AGENT_TEST_SPEAKER_ONE_LINE,
          model: AGENT_TEST_SPEECH_MODEL,
          voice: AGENT_TEST_SPEAKER_ONE_VOICE,
        },
      );
      speakerOneId = speakerOne.creationId ?? "";
      expect(speakerOneId).toBeTruthy();
      expect(speakerOne.localPath).toBeTruthy();

      const speakerTwo = await invokeOk<AudioGenerateResult>(
        agent,
        "generation.audio",
        {
          projectId,
          intent: "text_to_speech",
          prompt: AGENT_TEST_SPEAKER_TWO_LINE,
          model: AGENT_TEST_SPEECH_MODEL,
          voice: AGENT_TEST_SPEAKER_TWO_VOICE,
        },
      );
      speakerTwoId = speakerTwo.creationId ?? "";
      expect(speakerTwoId).toBeTruthy();
      expect(speakerTwo.localPath).toBeTruthy();
      expect(speakerTwoId).not.toBe(speakerOneId);

      const music = await invokeOk<AudioGenerateResult>(agent, "generation.audio", {
        projectId,
        intent: "text_to_music",
        prompt: AGENT_TEST_MUSIC_PROMPT,
        model: AGENT_TEST_MUSIC_MODEL,
      });
      musicId = music.creationId ?? "";
      expect(musicId).toBeTruthy();
      expect(music.localPath).toBeTruthy();

      await invokeOk(agent, "shell.show", { mode: "editor" });
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_EDITOR_AUDIO_GENERATE_RESULT_SCREEN);

      await invokeOk(agent, "timeline.place", {
        projectId,
        assetId: speakerOneId,
        audioTrack: 1,
      });
      await invokeOk(agent, "timeline.place", {
        projectId,
        assetId: speakerTwoId,
        audioTrack: 1,
      });
      await invokeOk(agent, "timeline.place", {
        projectId,
        assetId: musicId,
        audioTrack: 2,
      });
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_EDITOR_AUDIO_GENERATE_TIMELINE_SCREEN);

      const published = await Promise.all([
        publishHelpAudio(speakerOne.localPath!, AGENT_TEST_SPEAKER_ONE_PATH),
        publishHelpAudio(speakerTwo.localPath!, AGENT_TEST_SPEAKER_TWO_PATH),
        publishHelpAudio(music.localPath!, AGENT_TEST_MUSIC_PATH),
      ]);
      for (const path of published) {
        expect(existsSync(path)).toBe(true);
        expect(statSync(path).size).toBeGreaterThan(1000);
      }
    },
    20 * 60_000,
  );
});
