import { describe, expect, it } from "vitest";
import {
  buildParasceneAudioArgs,
  buildReplicateAudioInput,
  buildVoiceCloneInput,
  parseVoiceCloneOutput,
  persistAudioGenerateExtras,
  pickLocalAudioPath,
  voiceIdFromCreationMeta,
} from "./audioGenerateInputs";
import { REPLICATE_VOICE_CLONE_MODEL } from "./replicateAudioModels";

describe("audioGenerateInputs", () => {
  it("maps speech text and MiniMax voice_id", () => {
    expect(
      buildReplicateAudioInput({
        modelId: "minimax/speech-2.8-turbo",
        text: "Hello there",
        extras: { voiceId: "English_expressive_narrator", emotion: "happy" },
      }),
    ).toEqual({
      text: "Hello there",
      voice_id: "English_expressive_narrator",
      emotion: "happy",
    });
    expect(
      buildReplicateAudioInput({
        modelId: "minimax/speech-2.8-turbo",
        text: "Hello there",
        extras: { voiceId: "English_expressive_narrator", emotion: "excited" },
      }),
    ).toEqual({
      text: "Hello there",
      voice_id: "English_expressive_narrator",
    });
    expect(() =>
      buildReplicateAudioInput({
        modelId: "minimax/speech-2.8-turbo",
        text: "x".repeat(401),
      }),
    ).toThrow(/at most 400 characters/);
  });

  it("maps Gemini text, voice, and style prompt", () => {
    expect(
      buildReplicateAudioInput({
        modelId: "google/gemini-3.1-flash-tts",
        text: "Replacement line",
        extras: { geminiVoice: "Kore", stylePrompt: "warm studio" },
      }),
    ).toEqual({
      text: "Replacement line",
      voice: "Kore",
      prompt: "warm studio",
    });
  });

  it("uses a stamped voiceId when Gemini extras only have voiceId", () => {
    expect(
      buildReplicateAudioInput({
        modelId: "google/gemini-3.1-flash-tts",
        text: "Replacement line",
        extras: { voiceId: "Kore", stylePrompt: "warm studio" },
      }),
    ).toEqual({
      text: "Replacement line",
      voice: "Kore",
      prompt: "warm studio",
    });
  });

  it("maps Lyria prompt and skips image", () => {
    expect(
      buildReplicateAudioInput({
        modelId: "google/lyria-3",
        text: "tense strings",
      }),
    ).toEqual({ prompt: "tense strings" });
  });

  it("maps MiniMax music extras", () => {
    expect(
      buildReplicateAudioInput({
        modelId: "minimax/music-2.6",
        text: "night drive",
        extras: {
          lyrics: "city lights",
          instrumental: true,
          lyricsOptimizer: true,
        },
      }),
    ).toEqual({
      prompt: "night drive",
      lyrics: "city lights",
      is_instrumental: true,
      lyrics_optimizer: true,
    });
  });

  it("builds voice-clone input with speech-02-hd", () => {
    expect(buildVoiceCloneInput()).toEqual({
      model: REPLICATE_VOICE_CLONE_MODEL,
    });
  });

  it("parses clone JSON and prefers an audio file over output.json", () => {
    const parsed = parseVoiceCloneOutput({
      outputPreview: JSON.stringify({
        voice_id: "R8_FDU1SV5S",
        preview: "https://example.com/preview.mp3",
      }),
      localPaths: ["/tmp/run/output.json", "/tmp/run/preview.mp3"],
      outputUrls: ["https://example.com/preview.mp3"],
    });
    expect(parsed.voiceId).toBe("R8_FDU1SV5S");
    expect(parsed.previewPath).toBe("/tmp/run/preview.mp3");
    expect(pickLocalAudioPath(["/tmp/output.json"])).toBeNull();
  });

  it("persists clone source and voice extras for retry", () => {
    expect(
      persistAudioGenerateExtras({
        voiceId: " English_expressive_narrator ",
        cloneSourceAssetId: " audio-1 ",
        instrumental: false,
      }),
    ).toEqual({
      voiceId: "English_expressive_narrator",
      cloneSourceAssetId: "audio-1",
    });
  });

  it("maps Parascene MiniMax custom ids as voice=custom", () => {
    expect(
      buildParasceneAudioArgs({
        modelId: "minimax/speech-2.8-turbo",
        text: "Hello",
        extras: { voiceId: "trained-voice-99" },
      }),
    ).toEqual({
      prompt: "Hello",
      model: "minimax/speech-2.8-turbo",
      voice: "custom",
      voice_id: "trained-voice-99",
    });
  });

  it("maps Parascene MiniMax system voices without custom", () => {
    expect(
      buildParasceneAudioArgs({
        modelId: "minimax/speech-2.8-turbo",
        text: "Hello",
        extras: { voiceId: "English_expressive_narrator" },
      }),
    ).toEqual({
      prompt: "Hello",
      model: "minimax/speech-2.8-turbo",
      voice: "English_expressive_narrator",
    });
  });

  it("maps Parascene Gemini voice and style", () => {
    expect(
      buildParasceneAudioArgs({
        modelId: "google/gemini-3.1-flash-tts",
        text: "Line",
        extras: { geminiVoice: "Kore", stylePrompt: "warm" },
      }),
    ).toEqual({
      prompt: "Line",
      model: "google/gemini-3.1-flash-tts",
      voice: "Kore",
      style: "warm",
    });
  });

  it("reads voice_id from creation meta.audio", () => {
    expect(
      voiceIdFromCreationMeta({
        meta: { audio: { voice_id: " cloned-9 " } },
      }),
    ).toBe("cloned-9");
  });
});
