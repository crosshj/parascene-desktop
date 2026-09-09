import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TEST_SPEECH_PATH } from "./agentTestSpeech";
import {
  AGENT_TEST_AUDIO_PROJECT_PREFIX,
  AGENT_TEST_RENDER_GAP_SEC,
  AGENT_TEST_SPEAKER_LINE,
  AGENT_TEST_SPEAKER_VOICE,
  AGENT_TEST_SPEECH_MODEL,
} from "./agentTestAudioGenerate";

describe("agent audio generate fixture", () => {
  it("keeps suite 12 on one Flash generate, imported speech, A1/A2 gap, and a Publisher mix proof", () => {
    const testSrc = readFileSync(
      join(process.cwd(), "integration/12-audio-generate.integration.test.ts"),
      "utf8",
    );
    expect(testSrc).toContain("generation.audio");
    expect(testSrc).toContain("library.import");
    expect(testSrc).toContain("timeline.place");
    expect(testSrc).toContain("publisher.render");
    expect(testSrc).toContain("assertRenderProofWindows");
    expect(testSrc).toContain("dualTrackProofLayout");
    expect(testSrc).toContain("audioTrack: 1");
    expect(testSrc).toContain("audioTrack: 2");
    expect(testSrc).toContain("AGENT_TEST_SPEECH_PATH");
    expect(testSrc).toContain("AGENT_TEST_SPEECH_MODEL");
    expect(testSrc).toContain("generate: false");
    expect(testSrc).toContain("captureHelpScreen");
    expect(testSrc).toContain("sweepTestCreations");
    expect(testSrc).toContain("beforeAll");
    expect(testSrc).toContain("afterAll");
    expect(testSrc.indexOf("beforeAll")).toBeLessThan(testSrc.indexOf("afterAll"));
    expect(testSrc).not.toContain("text_to_music");
    expect(testSrc).not.toMatch(
      /voice.?train|voice-cloning|replicateVoiceTrain|minimax/i,
    );
    expect(testSrc.indexOf("generation.audio")).toBeLessThan(
      testSrc.indexOf("library.import"),
    );
    expect(testSrc.indexOf("timeline.place")).toBeLessThan(
      testSrc.indexOf("publisher.render"),
    );
    expect(AGENT_TEST_SPEECH_MODEL).toBe("google/gemini-3.1-flash-tts");
    expect(AGENT_TEST_SPEAKER_VOICE).toBe("Kore");
    expect(AGENT_TEST_SPEAKER_LINE).toContain("night market");
    expect(AGENT_TEST_RENDER_GAP_SEC).toBe(1.5);
    expect(AGENT_TEST_AUDIO_PROJECT_PREFIX).toContain("agent-test-audio-generate-");
    expect(existsSync(AGENT_TEST_SPEECH_PATH)).toBe(true);

    const help = readFileSync(
      join(process.cwd(), "public/help/generate-audio.html"),
      "utf8",
    );
    expect(help).toContain("desktop/screens/editor-generate-audio-prompt.png");
    expect(help).toContain("desktop/screens/editor-generate-audio-result.png");
    expect(help).toContain("desktop/screens/editor-generate-audio-timeline.png");
    expect(help).toContain("desktop/media/generate-audio-kore.mp3");
    expect(help).toContain("desktop/media/agent-test-speech.mp3");
    expect(help).toContain(AGENT_TEST_SPEAKER_LINE);
    expect(help).toContain("Gemini 3.1 Flash TTS");
    expect(help).toContain("Kore");
    expect(help).toContain("Add from disk");
    expect(help).toContain("Publisher");
    expect(help).not.toMatch(/the (A2V |desktop )?test/i);
    expect(help).not.toContain("writes this screenshot");
  });
});
