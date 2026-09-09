import { describe, expect, it } from "vitest";
import {
  audioModelChipClass,
  audioModelChipFromClip,
  audioModelChipFromCreation,
  audioModelChipLabel,
} from "./audioModelChip";
import {
  creationUpsertWithAddAssetGeneration,
  makeLibraryAudioGeneration,
} from "../project/desktopAddAssetGeneration";
import type { Creation } from "./types";

function audioCreation(remoteJson: string | null): Creation {
  return {
    id: "a1",
    title: "Line",
    mediaType: "audio",
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: "/tmp/a1.mp3",
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "2026-09-07T00:00:00.000Z",
    downloadState: "local",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-09-07T00:00:00.000Z",
    filename: "a1.mp3",
    description: null,
    color: null,
    status: null,
    width: null,
    height: null,
    aspectRatio: null,
    nsfw: false,
    isModeratedError: false,
    remoteJson,
  };
}

describe("audioModelChipLabel", () => {
  it("maps curated speech and Lyria slugs", () => {
    expect(audioModelChipLabel("google/lyria-3")).toBe("LYRIA");
    expect(audioModelChipLabel("google/gemini-3.1-flash-tts")).toBe("FLASH");
    expect(audioModelChipLabel("Gemini 3.1 Flash TTS")).toBe("FLASH");
    expect(audioModelChipLabel("minimax/speech-2.8-turbo")).toBe("MM SPEECH");
    expect(audioModelChipLabel("minimax/music-2.6")).toBe("MM MUSIC");
    expect(audioModelChipLabel("MiniMax Music 2.6")).toBe("MM MUSIC");
    expect(audioModelChipClass("LYRIA")).toBe("lyria");
    expect(audioModelChipClass("FLASH")).toBe("flash");
    expect(audioModelChipClass("MM SPEECH")).toBe("mm-speech");
    expect(audioModelChipClass("MM MUSIC")).toBe("mm-music");
  });

  it("skips clone and unknown models", () => {
    expect(audioModelChipLabel("minimax/voice-cloning")).toBeNull();
    expect(audioModelChipLabel("suno")).toBeNull();
    expect(audioModelChipLabel("")).toBeNull();
  });
});

describe("audioModelChipFromCreation", () => {
  it("reads Flash from Parascene replicateSpeech meta without a desktop stamp", () => {
    const creation = audioCreation(
      JSON.stringify({
        meta: {
          method: "replicateSpeech",
          server_id: 1,
          args: {
            model: "google/gemini-3.1-flash-tts",
            prompt: "The night market is still open.",
            voice: "Kore",
          },
        },
      }),
    );
    expect(audioModelChipFromCreation(creation)).toBe("FLASH");
  });

  it("reads MiniMax Music from Parascene replicateMusic meta", () => {
    const creation = audioCreation(
      JSON.stringify({
        meta: {
          method: "replicateMusic",
          server_id: 1,
          args: {
            model: "minimax/music-2.6",
            prompt: "night market score",
          },
        },
      }),
    );
    expect(audioModelChipFromCreation(creation)).toBe("MM MUSIC");
  });

  it("reads the stamped generate model", () => {
    const upsert = creationUpsertWithAddAssetGeneration(
      audioCreation("{}"),
      makeLibraryAudioGeneration({
        prompt: "line",
        creationId: "a1",
        model: "google/gemini-3.1-flash-tts",
        intentId: "text_to_speech",
        extras: { geminiVoice: "Kore" },
      }),
    );
    expect(audioModelChipFromCreation(audioCreation(upsert.remoteJson))).toBe(
      "FLASH",
    );
  });
});

describe("audioModelChipFromClip", () => {
  it("reads a stamped speech model on an audio clip", () => {
    expect(
      audioModelChipFromClip({
        kind: "audio",
        lane: "audio",
        addAssetGeneration: { model: "minimax/speech-2.8-turbo" },
      }),
    ).toBe("MM SPEECH");
  });

  it("ignores video clips and unstamped audio", () => {
    expect(
      audioModelChipFromClip({
        kind: "video",
        addAssetGeneration: { model: "google/lyria-3" },
      }),
    ).toBeNull();
    expect(
      audioModelChipFromClip({ kind: "audio", lane: "audio" }),
    ).toBeNull();
  });
});
