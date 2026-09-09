import { describe, expect, it } from "vitest";
import {
  projectVoiceOptions,
  voiceIdFromCreation,
} from "./projectVoiceAssets";
import {
  creationUpsertWithAddAssetGeneration,
  makeLibraryAudioGeneration,
} from "../../project/desktopAddAssetGeneration";
import type { Creation } from "../../library/types";

function audioCreation(
  id: string,
  remoteJson: string | null,
): Creation {
  return {
    id,
    title: `Voice ${id}`,
    mediaType: "audio",
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: "/tmp/a.mp3",
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    downloadState: "local",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    filename: "a.mp3",
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

describe("projectVoiceAssets", () => {
  it("reads a stamped voice_id from local generation meta", () => {
    const upsert = creationUpsertWithAddAssetGeneration(
      audioCreation("c1", "{}"),
      makeLibraryAudioGeneration({
        prompt: "clone",
        creationId: "c1",
        model: "minimax/voice-cloning",
        intentId: "text_to_speech",
        voiceId: "R8_FDU1SV5S",
      }),
    );
    const row = audioCreation("c1", upsert.remoteJson);
    expect(voiceIdFromCreation(row)).toBe("R8_FDU1SV5S");
    expect(projectVoiceOptions([row]).map((v) => v.voiceId)).toEqual([
      "R8_FDU1SV5S",
    ]);
  });

  it("ignores audio without a stamp", () => {
    expect(voiceIdFromCreation(audioCreation("c2", null))).toBeNull();
  });
});
