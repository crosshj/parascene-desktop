import { describe, expect, it } from "vitest";
import {
  GEMINI_SYSTEM_VOICES,
  geminiSystemVoiceLabel,
  isGeminiSystemVoiceId,
} from "./geminiSystemVoices";

describe("geminiSystemVoices", () => {
  it("keeps official ids and descriptive labels", () => {
    expect(GEMINI_SYSTEM_VOICES.some((voice) => voice.voiceId === "Kore")).toBe(
      true,
    );
    expect(geminiSystemVoiceLabel("Kore")).toBe(
      "Kore — Female; firm and confident",
    );
    expect(geminiSystemVoiceLabel("Zubenelgenubi")).toContain(
      "casual and conversational",
    );
    expect(isGeminiSystemVoiceId("Umbriel")).toBe(true);
    expect(isGeminiSystemVoiceId("not-a-voice")).toBe(false);
  });

  it("falls back to the raw id for unknown voices", () => {
    expect(geminiSystemVoiceLabel("CustomVoice")).toBe("CustomVoice");
  });
});
