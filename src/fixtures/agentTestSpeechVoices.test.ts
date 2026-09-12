import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MINIMAX_ENGLISH_FAQ_VOICES,
  MINIMAX_SYSTEM_VOICE_FAQ_URL,
  isMiniMaxSystemVoiceId,
} from "../layouts/editor/minimaxSystemVoices";
import { buildParasceneAudioArgs } from "../layouts/editor/audioGenerateInputs";
import {
  AGENT_TEST_GEMINI_MAJOR_VOICES,
  AGENT_TEST_GEMINI_SPEECH_MODEL,
  AGENT_TEST_MINIMAX_SPEECH_MODEL,
  AGENT_TEST_SPEECH_VOICES_CUSTOM_ID,
  AGENT_TEST_SPEECH_VOICES_LINE,
  AGENT_TEST_SPEECH_VOICES_PAUSE,
  AGENT_TEST_SPEECH_VOICES_PROJECT_PREFIX,
  speechVoiceClips,
  speechVoiceInvokeArgs,
  speechVoiceRel,
  writeSpeechVoicesHelpPage,
} from "./agentTestSpeechVoices";

describe("agent speech voices fixture", () => {
  it("covers every English FAQ id, Custom vs picker, and writes the Help page", () => {
    const clips = speechVoiceClips();
    const minimax = clips.filter((clip) => clip.section === "minimax");
    const custom = clips.filter((clip) => clip.source === "custom");
    const picker = clips.filter((clip) => clip.source === "picker");
    const gemini = clips.filter((clip) => clip.section === "gemini");
    const delivery = clips.filter((clip) => clip.section === "delivery");

    expect(minimax).toHaveLength(45);
    expect(minimax.map((clip) => clip.voice)).toEqual(
      MINIMAX_ENGLISH_FAQ_VOICES.map((voice) => voice.voiceId),
    );
    expect(picker.length).toBe(13);
    expect(custom.length).toBe(32);
    expect(custom.some((clip) => clip.voice === AGENT_TEST_SPEECH_VOICES_CUSTOM_ID)).toBe(
      true,
    );
    expect(isMiniMaxSystemVoiceId(AGENT_TEST_SPEECH_VOICES_CUSTOM_ID)).toBe(false);
    expect(gemini.map((clip) => clip.voice)).toEqual([...AGENT_TEST_GEMINI_MAJOR_VOICES]);
    expect(delivery.length).toBe(6);
    expect(delivery.some((clip) => clip.prompt === AGENT_TEST_SPEECH_VOICES_PAUSE)).toBe(
      true,
    );

    const customArgs = buildParasceneAudioArgs({
      modelId: AGENT_TEST_MINIMAX_SPEECH_MODEL,
      text: AGENT_TEST_SPEECH_VOICES_LINE,
      extras: { voiceId: AGENT_TEST_SPEECH_VOICES_CUSTOM_ID },
    });
    expect(customArgs.voice).toBe("custom");
    expect(customArgs.voice_id).toBe(AGENT_TEST_SPEECH_VOICES_CUSTOM_ID);

    const invoke = speechVoiceInvokeArgs(
      custom.find((clip) => clip.voice === AGENT_TEST_SPEECH_VOICES_CUSTOM_ID)!,
      "proj-1",
    );
    expect(invoke.voice).toBe(AGENT_TEST_SPEECH_VOICES_CUSTOM_ID);
    expect(invoke.model).toBe(AGENT_TEST_MINIMAX_SPEECH_MODEL);

    const dest = writeSpeechVoicesHelpPage();
    const help = readFileSync(dest, "utf8");
    expect(help).toContain("<h1>Speech voices</h1>");
    expect(help).toContain(AGENT_TEST_SPEECH_VOICES_LINE);
    expect(help).toContain("Wait for it. &lt;#1.0#&gt; There.");
    expect(help).toContain(AGENT_TEST_SPEECH_VOICES_CUSTOM_ID);
    expect(help).toContain(MINIMAX_SYSTEM_VOICE_FAQ_URL);
    expect(help).toContain(`href="${MINIMAX_SYSTEM_VOICE_FAQ_URL}" target="_blank" rel="noopener noreferrer"`);
    expect(help).toContain("desktop/screens/editor-speech-voices-custom.png");
    expect(help).toContain("desktop/screens/editor-speech-voices-markup.png");
    expect(help).toContain("desktop/screens/editor-speech-voices-gemini-style.png");
    expect(help).not.toContain("minimax-inline-happy.mp3");
    expect(help).not.toContain("{happy}The results are in.{/happy}");
    expect(help).toContain("Where to go from here");
    expect(help).toContain("generate-audio.html");
    expect(help).toContain("audio-models.html");
    expect(help).not.toMatch(/the (A2V |desktop )?test/i);
    expect(help).not.toContain("writes this screenshot");
    expect(help).not.toContain("agent-test-");
    for (const clip of clips) {
      expect(help).toContain(`src="${speechVoiceRel(clip)}"`);
      expect(help).toContain(clip.voice);
    }

    const testSrc = readFileSync(
      join(process.cwd(), "integration/13-speech-voices.integration.test.ts"),
      "utf8",
    );
    expect(testSrc).toContain("generation.audio");
    expect(testSrc).toContain("writeSpeechVoicesHelpPage");
    expect(testSrc).toContain("AGENT_TEST_SPEECH_VOICES_CUSTOM_ID");
    expect(testSrc).toContain("emotion");
    expect(testSrc).toContain("style");
    expect(testSrc).toContain("generate: false");
    expect(testSrc).toContain("captureHelpScreen");
    expect(testSrc).not.toMatch(/voice.?train|voice-cloning|replicateVoiceTrain/i);
    expect(AGENT_TEST_SPEECH_VOICES_PROJECT_PREFIX).toContain("agent-test-speech-voices-");
    expect(AGENT_TEST_GEMINI_SPEECH_MODEL).toBe("google/gemini-3.1-flash-tts");
    expect(existsSync(dest)).toBe(true);
  });
});
