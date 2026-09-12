import { describe, expect, it } from "vitest";
import {
  MINIMAX_ENGLISH_FAQ_VOICES,
  MINIMAX_SPEECH_EMOTIONS,
  MINIMAX_SYSTEM_VOICE_FAQ_URL,
  MINIMAX_SYSTEM_VOICES,
  isMiniMaxEnglishFaqVoiceId,
  isMiniMaxSystemVoiceId,
  normalizeMinimaxEmotion,
} from "./minimaxSystemVoices";

describe("minimaxSystemVoices", () => {
  it("points at the official MiniMax FAQ and keeps exact ids", () => {
    expect(MINIMAX_SYSTEM_VOICE_FAQ_URL).toBe(
      "https://platform.minimax.io/docs/faq/system-voice-id",
    );
    expect(MINIMAX_ENGLISH_FAQ_VOICES).toHaveLength(45);
    expect(
      MINIMAX_SYSTEM_VOICES.some(
        (voice) => voice.voiceId === "English_expressive_narrator",
      ),
    ).toBe(true);
    expect(isMiniMaxSystemVoiceId("English_expressive_narrator")).toBe(true);
    expect(isMiniMaxEnglishFaqVoiceId("English_Whispering_girl")).toBe(true);
    expect(isMiniMaxSystemVoiceId("English_Whispering_girl")).toBe(false);
    expect(isMiniMaxSystemVoiceId("English_CasualMan")).toBe(true);
    expect(isMiniMaxEnglishFaqVoiceId("English_CasualMan")).toBe(false);
    expect(isMiniMaxSystemVoiceId("R8_FDU1SV5S")).toBe(false);
    const pickerOnFaq = MINIMAX_SYSTEM_VOICES.filter((voice) =>
      isMiniMaxEnglishFaqVoiceId(voice.voiceId),
    );
    expect(pickerOnFaq.length).toBe(13);
  });

  it("normalizes official speech emotions", () => {
    expect(MINIMAX_SPEECH_EMOTIONS.map((e) => e.value)).toContain("auto");
    expect(normalizeMinimaxEmotion("Happy")).toBe("happy");
    expect(normalizeMinimaxEmotion("excited")).toBe("");
  });
});
