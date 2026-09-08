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
    expect(audioModelChipLabel("minimax/speech-2.8-hd")).toBe("MM SPEECH");
    expect(audioModelChipClass("LYRIA")).toBe("lyria");
    expect(audioModelChipClass("FLASH")).toBe("flash");
    expect(audioModelChipClass("MM SPEECH")).toBe("mm-speech");
  });

  it("skips music, clone, and unknown models", () => {
    expect(audioModelChipLabel("minimax/music-2.6")).toBeNull();
    expect(audioModelChipLabel("minimax/voice-cloning")).toBeNull();
    expect(audioModelChipLabel("suno")).toBeNull();
    expect(audioModelChipLabel("")).toBeNull();
  });
});

describe("audioModelChipFromCreation", () => {
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
        addAssetGeneration: { model: "minimax/speech-2.8-hd" },
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
