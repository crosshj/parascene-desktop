import { existsSync, statSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { invokeOk, loadAgentManifest, requireSignedIn } from "./agentClient";
import { captureHelpScreen, publishHelpAudio, syncHelpFileList } from "./helpArtifacts";
import { assertRenderProofWindows } from "./probeRenderAudio";
import { sweepTestCreations } from "./teardown";
import {
  dualTrackProofLayout,
  proofWindows,
} from "../src/agent/renderAudioProof";
import {
  AGENT_TEST_AUDIO_PROJECT_PREFIX,
  AGENT_TEST_EDITOR_AUDIO_GENERATE_PROMPT_SCREEN,
  AGENT_TEST_EDITOR_AUDIO_GENERATE_RESULT_SCREEN,
  AGENT_TEST_EDITOR_AUDIO_GENERATE_TIMELINE_SCREEN,
  AGENT_TEST_FLASH_TTS_PATH,
  AGENT_TEST_RENDER_GAP_SEC,
  AGENT_TEST_SPEAKER_LINE,
  AGENT_TEST_SPEAKER_VOICE,
  AGENT_TEST_SPEECH_MODEL,
} from "../src/fixtures/agentTestAudioGenerate";
import {
  AGENT_TEST_SPEECH_DURATION_SEC,
  AGENT_TEST_SPEECH_PATH,
} from "../src/fixtures/agentTestSpeech";

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

type ImportResult = {
  creations?: Array<{ id?: string; localPath?: string | null }>;
};

type TimelinePlaceResult = {
  clipId?: string;
  assetId?: string;
  audioTrack?: number;
  startSec?: number;
  endSec?: number;
};

type PublisherRenderResult = {
  renderId?: string;
  path?: string | null;
  durationSec?: number;
  status?: string;
};

const stamp = Date.now();
const title = `${AGENT_TEST_AUDIO_PROJECT_PREFIX}${stamp}`;
let projectId = "";
let folderId = "";
let flashId = "";
let speechId = "";

function sweepThisSuite() {
  return {
    ids: [flashId, speechId],
    titleContains: [AGENT_TEST_AUDIO_PROJECT_PREFIX],
    pathContains: ["agent-test-speech"],
    promptContains: [AGENT_TEST_SPEAKER_LINE],
    projectId,
    folderId,
  };
}

describe("agent audio generate", () => {
  beforeAll(async () => {
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, sweepThisSuite());
  }, 120_000);

  afterAll(async () => {
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, sweepThisSuite());
  }, 120_000);

  it(
    "generates Flash TTS, places imported speech on A2 after a gap, and proves both tracks in the Publisher mix",
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
        prompt: AGENT_TEST_SPEAKER_LINE,
        model: AGENT_TEST_SPEECH_MODEL,
        voice: AGENT_TEST_SPEAKER_VOICE,
        generate: false,
      });
      expect(form.staged).toBe(true);
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_EDITOR_AUDIO_GENERATE_PROMPT_SCREEN, {
        keepUi: true,
      });

      const flash = await invokeOk<AudioGenerateResult>(
        agent,
        "generation.audio",
        {
          projectId,
          intent: "text_to_speech",
          prompt: AGENT_TEST_SPEAKER_LINE,
          model: AGENT_TEST_SPEECH_MODEL,
          voice: AGENT_TEST_SPEAKER_VOICE,
        },
      );
      flashId = flash.creationId ?? "";
      expect(flashId).toBeTruthy();
      expect(flash.localPath).toBeTruthy();

      const imported = await invokeOk<ImportResult>(agent, "library.import", {
        projectId,
        paths: [AGENT_TEST_SPEECH_PATH],
      });
      speechId = imported.creations?.[0]?.id ?? "";
      expect(speechId).toBeTruthy();
      expect(speechId).not.toBe(flashId);

      await invokeOk(agent, "shell.show", { mode: "editor" });
      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_EDITOR_AUDIO_GENERATE_RESULT_SCREEN);

      const flashClip = await invokeOk<TimelinePlaceResult>(
        agent,
        "timeline.place",
        {
          projectId,
          assetId: flashId,
          audioTrack: 1,
          startSec: 0,
        },
      );
      expect(flashClip.audioTrack).toBe(1);
      expect(flashClip.startSec).toBe(0);
      const flashDurationSec = (flashClip.endSec ?? 0) - (flashClip.startSec ?? 0);
      expect(flashDurationSec).toBeGreaterThan(1.2);

      const layout = dualTrackProofLayout({
        flashDurationSec,
        speechDurationSec: AGENT_TEST_SPEECH_DURATION_SEC,
        gapSec: AGENT_TEST_RENDER_GAP_SEC,
      });

      const speechClip = await invokeOk<TimelinePlaceResult>(
        agent,
        "timeline.place",
        {
          projectId,
          assetId: speechId,
          audioTrack: 2,
          startSec: layout.speech.startSec,
        },
      );
      expect(speechClip.audioTrack).toBe(2);
      expect(speechClip.startSec).toBeCloseTo(layout.speech.startSec, 2);
      expect((speechClip.endSec ?? 0) - (speechClip.startSec ?? 0)).toBeGreaterThan(
        2,
      );

      await invokeOk(agent, "window.setSize", { width: 1280, height: 900 });
      await captureHelpScreen(AGENT_TEST_EDITOR_AUDIO_GENERATE_TIMELINE_SCREEN);

      const render = await invokeOk<PublisherRenderResult>(
        agent,
        "publisher.render",
        { projectId },
      );
      expect(render.status).toBe("ready");
      expect(render.renderId).toBeTruthy();
      expect(render.path && existsSync(render.path)).toBe(true);
      expect(render.durationSec ?? 0).toBeGreaterThan(layout.speech.startSec + 2);

      const windows = proofWindows({
        ...layout,
        speech: {
          startSec: speechClip.startSec ?? layout.speech.startSec,
          endSec: speechClip.endSec ?? layout.speech.endSec,
        },
      });
      expect(windows.map((window) => window.expect)).toEqual([
        "audio",
        "silence",
        "audio",
      ]);
      await assertRenderProofWindows(render.path!, windows);

      const published = await publishHelpAudio(
        flash.localPath!,
        AGENT_TEST_FLASH_TTS_PATH,
      );
      expect(existsSync(published)).toBe(true);
      expect(statSync(published).size).toBeGreaterThan(1000);
      await syncHelpFileList();
    },
    20 * 60_000,
  );
});
