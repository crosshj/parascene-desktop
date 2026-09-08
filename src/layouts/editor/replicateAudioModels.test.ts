import { describe, expect, it } from "vitest";
import {
  CURATED_REPLICATE_AUDIO_MODELS,
  curatedAudioModelsForIntent,
  findCuratedAudioModel,
  pickCuratedAudioModelId,
  REPLICATE_VOICE_CLONE_MODEL,
  REPLICATE_VOICE_CLONE_SLUG,
} from "./replicateAudioModels";

describe("replicateAudioModels", () => {
  it("curates four generate models plus MiniMax clone", () => {
    expect(CURATED_REPLICATE_AUDIO_MODELS.map((m) => m.id)).toEqual([
      "minimax/speech-2.8-hd",
      "google/gemini-3.1-flash-tts",
      "google/lyria-3",
      "minimax/music-2.6",
    ]);
    expect(curatedAudioModelsForIntent("text_to_speech")).toHaveLength(2);
    expect(curatedAudioModelsForIntent("text_to_music")).toHaveLength(2);
    expect(findCuratedAudioModel("minimax/speech-2.8-hd")?.textField).toBe(
      "text",
    );
    expect(REPLICATE_VOICE_CLONE_SLUG).toBe("minimax/voice-cloning");
    expect(REPLICATE_VOICE_CLONE_MODEL).toBe("speech-02-hd");
  });

  it("maps a Gemini display label onto the curated slug", () => {
    const speech = curatedAudioModelsForIntent("text_to_speech");
    expect(pickCuratedAudioModelId(speech, null, "Gemini 3.1 Flash TTS")).toBe(
      "google/gemini-3.1-flash-tts",
    );
    expect(
      pickCuratedAudioModelId(
        speech,
        "minimax/speech-2.8-hd",
        "google/gemini-3.1-flash-tts",
      ),
    ).toBe("google/gemini-3.1-flash-tts");
    expect(
      pickCuratedAudioModelId(speech, "minimax/speech-2.8-hd", null),
    ).toBe("minimax/speech-2.8-hd");
  });
});
