import { describe, expect, it } from "vitest";
import {
  MINIMAX_SYSTEM_VOICE_FAQ_URL,
  MINIMAX_SYSTEM_VOICES,
  isMiniMaxSystemVoiceId,
} from "./minimaxSystemVoices";

describe("minimaxSystemVoices", () => {
  it("points at the official MiniMax FAQ and keeps exact ids", () => {
    expect(MINIMAX_SYSTEM_VOICE_FAQ_URL).toBe(
      "https://platform.minimax.io/docs/faq/system-voice-id",
    );
    expect(
      MINIMAX_SYSTEM_VOICES.some(
        (voice) => voice.voiceId === "English_expressive_narrator",
      ),
    ).toBe(true);
    expect(isMiniMaxSystemVoiceId("English_expressive_narrator")).toBe(true);
    expect(isMiniMaxSystemVoiceId("R8_FDU1SV5S")).toBe(false);
  });
});
