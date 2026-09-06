import { existsSync, statSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { invokeOk, loadAgentManifest, requireSignedIn } from "./agentClient";
import { captureHelpScreen, publishHelpMedia } from "./helpArtifacts";
import {
  clearGenerateJourney,
  JOURNEY_PROJECT_TITLE_PREFIX,
  requireGenerateJourney,
} from "./journeyState";
import { sweepTestCreations } from "./teardown";
import {
  AGENT_TEST_A2V_DURATION_SEC,
  AGENT_TEST_A2V_PROMPT,
  AGENT_TEST_EDITOR_A2V_FORM_SCREEN,
  AGENT_TEST_EDITOR_A2V_SCREEN,
  AGENT_TEST_EDITOR_AUDIO_SCREEN,
  AGENT_TEST_SPEECH_DURATION_SEC,
  AGENT_TEST_SPEECH_PATH,
  AGENT_TEST_STILL_PATH,
} from "../src/fixtures/agentTestSpeech";

type ProjectCreateResult = {
  projectId?: string;
  folderId?: string | null;
};

type ImportResult = {
  creations?: Array<{ id: string; localPath?: string | null }>;
};

type A2vResult = {
  creationId?: string;
  stillId?: string;
  audioId?: string;
  audioDurationSec?: number;
  clipDurationSec?: number;
  localPath?: string | null;
  videosGroupId?: string | null;
  staged?: boolean;
};

let projectId = "";
let folderId = "";
let stillId = "";
let audioId = "";
let videoId = "";
let imagesGroupId = "";
let videosGroupId = "";

describe("agent audio to video", () => {
  afterAll(async () => {
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, {
      ids: [videoId, stillId, audioId, imagesGroupId, videosGroupId],
      titleContains: [
        JOURNEY_PROJECT_TITLE_PREFIX,
        "agent-test-a2v",
        "agent-test-speech",
        "agent-test-still",
      ],
      pathContains: ["agent-test-speech", "agent-test-still"],
      projectId,
      folderId,
    });
    clearGenerateJourney();
  }, 120_000);

  it(
    "continues the generate project, places the full speech on the timeline, runs the first 9s of LTX lip-sync, and publishes the clip",
    async () => {
      const agent = await loadAgentManifest();
      await requireSignedIn(agent);
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });

      const journey = requireGenerateJourney();
      projectId = journey.projectId;
      folderId = journey.folderId;
      stillId = journey.stillId;
      imagesGroupId = journey.imagesGroupId;
      expect(existsSync(journey.localPath)).toBe(true);

      await invokeOk(agent, "project.open", { id: projectId, mode: "editor" });

      const imported = await invokeOk<ImportResult>(agent, "library.import", {
        projectId,
        paths: [AGENT_TEST_SPEECH_PATH],
      });
      audioId = imported.creations?.[0]?.id ?? "";
      expect(audioId).toBeTruthy();
      expect(imported.creations?.[0]?.localPath ?? "").toContain("agent-test-speech");

      const staged = await invokeOk<A2vResult>(
        agent,
        "generation.a2v",
        {
          projectId,
          stillId,
          audioId,
          prompt: AGENT_TEST_A2V_PROMPT,
          durationSec: AGENT_TEST_A2V_DURATION_SEC,
          generate: false,
        },
      );
      expect(staged.staged).toBe(true);
      expect(staged.audioId).toBe(audioId);
      expect(staged.stillId ?? stillId).toBe(stillId);
      expect(staged.audioDurationSec ?? 0).toBeGreaterThan(
        AGENT_TEST_SPEECH_DURATION_SEC - 1,
      );
      expect(staged.clipDurationSec).toBe(AGENT_TEST_A2V_DURATION_SEC);
      expect(staged.creationId ?? "").toBe("");
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_EDITOR_AUDIO_SCREEN);

      const form = await invokeOk<A2vResult>(agent, "generation.a2v", {
        projectId,
        stillId,
        audioId,
        prompt: AGENT_TEST_A2V_PROMPT,
        durationSec: AGENT_TEST_A2V_DURATION_SEC,
        generate: false,
        form: true,
      });
      expect(form.staged).toBe(true);
      expect(form.audioId).toBe(audioId);
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_EDITOR_A2V_FORM_SCREEN, {
        keepUi: true,
      });

      const generated = await invokeOk<A2vResult>(agent, "generation.a2v", {
        projectId,
        stillId,
        audioId,
        prompt: AGENT_TEST_A2V_PROMPT,
        durationSec: AGENT_TEST_A2V_DURATION_SEC,
      });
      videoId = generated.creationId ?? "";
      videosGroupId = generated.videosGroupId ?? "";
      expect(videoId).toBeTruthy();
      expect(generated.audioId).toBe(audioId);
      expect(generated.audioDurationSec ?? 0).toBeGreaterThan(
        AGENT_TEST_SPEECH_DURATION_SEC - 1,
      );
      expect(generated.clipDurationSec).toBe(AGENT_TEST_A2V_DURATION_SEC);
      expect(generated.localPath).toBeTruthy();

      await invokeOk(agent, "shell.show", { mode: "editor" });
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_EDITOR_A2V_SCREEN);

      const published = await publishHelpMedia({
        videoPath: generated.localPath,
      });
      expect(published.video).toBeTruthy();
      expect(existsSync(published.video!)).toBe(true);
      expect(existsSync(AGENT_TEST_STILL_PATH)).toBe(true);
      expect(statSync(published.video!).size).toBeGreaterThan(10_000);
      expect(statSync(AGENT_TEST_STILL_PATH).size).toBeGreaterThan(10_000);
      expect(Date.now() - statSync(published.video!).mtimeMs).toBeLessThan(30_000);
      expect(statSync(AGENT_TEST_EDITOR_AUDIO_SCREEN).size).toBeGreaterThan(50_000);
      expect(statSync(AGENT_TEST_EDITOR_A2V_FORM_SCREEN).size).toBeGreaterThan(50_000);
      expect(statSync(AGENT_TEST_EDITOR_A2V_SCREEN).size).toBeGreaterThan(50_000);
    },
    12 * 60_000,
  );

  it(
    "deletes the project before catalog rows so a staged timeline does not block teardown",
    async () => {
      const agent = await loadAgentManifest();
      await requireSignedIn(agent);
      const created = await invokeOk<ProjectCreateResult>(agent, "project.create", {
        title: `agent-test-a2v-teardown-${Date.now()}`,
      });
      const teardownProjectId = created.projectId ?? "";
      const teardownFolderId = created.folderId ?? "";
      expect(teardownProjectId).toBeTruthy();

      const imported = await invokeOk<ImportResult>(agent, "library.import", {
        projectId: teardownProjectId,
        paths: [AGENT_TEST_STILL_PATH, AGENT_TEST_SPEECH_PATH],
      });
      const teardownStillId =
        imported.creations?.find((row) => row.localPath?.includes("agent-test-still"))
          ?.id ?? "";
      const teardownAudioId =
        imported.creations?.find((row) => row.localPath?.includes("agent-test-speech"))
          ?.id ?? "";
      expect(teardownStillId).toBeTruthy();
      expect(teardownAudioId).toBeTruthy();

      const staged = await invokeOk<A2vResult>(agent, "generation.a2v", {
        projectId: teardownProjectId,
        stillId: teardownStillId,
        audioId: teardownAudioId,
        prompt: AGENT_TEST_A2V_PROMPT,
        durationSec: AGENT_TEST_A2V_DURATION_SEC,
        generate: false,
      });
      expect(staged.staged).toBe(true);
      expect(staged.audioDurationSec ?? 0).toBeGreaterThan(
        AGENT_TEST_SPEECH_DURATION_SEC - 1,
      );

      await sweepTestCreations(agent, {
        ids: [teardownStillId, teardownAudioId],
        titleContains: ["agent-test-a2v-teardown"],
        projectId: teardownProjectId,
        folderId: teardownFolderId,
      });
      const leftover = await invokeOk<{ found?: Array<{ id: string }> }>(
        agent,
        "library.lookup",
        { titleContains: "agent-test-a2v-teardown" },
      );
      expect(leftover.found ?? []).toEqual([]);
    },
    120_000,
  );
});
