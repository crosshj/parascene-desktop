import { describe, expect, it } from "vitest";
import {
  attachAudioCreationRangeArgs,
  creationSupportsCdnAudioWindow,
} from "./cdnAudioCreation";
import type { Creation } from "./types";

function base(overrides: Partial<Creation> = {}): Creation {
  return {
    id: "27140",
    title: "Dichotomy",
    mediaType: "audio",
    remoteUrl: "https://www.parascene.com/api/create/images/27140/audio",
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: "/tmp/27140.mp3",
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "2026-08-30T00:00:00Z",
    downloadState: "local",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-08-30T00:00:00Z",
    filename: "cover.png",
    description: null,
    color: null,
    status: "completed",
    width: null,
    height: null,
    aspectRatio: null,
    nsfw: false,
    isModeratedError: false,
    remoteJson: JSON.stringify({
      meta: {
        audio: {
          cdn_id: "o_8972e00517b91de76c0d3c64",
          duration: 314.24,
        },
      },
    }),
    ...overrides,
  };
}

describe("attachAudioCreationRangeArgs", () => {
  it("sends creation id and range only", () => {
    const args: Record<string, unknown> = { prompt: "x" };
    attachAudioCreationRangeArgs(args, {
      creationId: 27140,
      startSec: 8,
      durationSec: 9,
    });
    expect(args.audio_creation_id).toBe(27140);
    expect(args.audio_start_sec).toBe(8);
    expect(args.audio_duration_sec).toBe(9);
    expect(args).not.toHaveProperty("input_audio_urls");
    expect(args).not.toHaveProperty("audio_url");
    expect(args).not.toHaveProperty("audio_clip_id");
  });
});

describe("creationSupportsCdnAudioWindow", () => {
  it("accepts synced CDN audio Creations", () => {
    expect(creationSupportsCdnAudioWindow(base())).toBe(true);
  });

  it("rejects local-only ids", () => {
    expect(
      creationSupportsCdnAudioWindow(base({ id: "local-123", remoteJson: null })),
    ).toBe(false);
  });

  it("rejects cover-only / no cdn_id", () => {
    expect(
      creationSupportsCdnAudioWindow(
        base({
          remoteUrl: "https://cdn.example/cover.png",
          remoteJson: JSON.stringify({
            meta: { import: { provider: "suno" } },
          }),
        }),
      ),
    ).toBe(false);
  });

  it("accepts audio_url path without meta when remoteUrl is the Parascene audio path", () => {
    expect(
      creationSupportsCdnAudioWindow(
        base({
          remoteJson: null,
          remoteUrl: "https://www.parascene.com/api/create/images/99/audio",
        }),
      ),
    ).toBe(true);
  });
});
