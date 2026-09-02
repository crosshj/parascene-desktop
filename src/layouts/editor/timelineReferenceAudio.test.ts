import { describe, expect, it } from "vitest";
import type { Creation } from "../../library/types";
import {
  attachParasceneAudioClipId,
  isGenericPromptAudioUrl,
  isProviderFetchableAudioUrl,
  parasceneProductTimelineAudioKind,
} from "./timelineReferenceAudio";

function audioCreation(
  overrides: Partial<Pick<Creation, "id" | "mediaType" | "remoteUrl" | "remoteJson">> = {},
): Pick<Creation, "id" | "mediaType" | "remoteUrl" | "remoteJson"> {
  return {
    id: "27140",
    mediaType: "audio",
    remoteUrl: "https://www.parascene.com/api/create/images/27140/audio",
    remoteJson: JSON.stringify({
      meta: { audio: { cdn_id: "o_8972e00517b91de76c0d3c64" } },
    }),
    ...overrides,
  };
}

describe("parasceneProductTimelineAudioKind", () => {
  it("uses a library clip for local (non-Parascene) timeline audio", () => {
    expect(
      parasceneProductTimelineAudioKind(
        "full_mix",
        audioCreation({
          id: "local-mix",
          remoteUrl: null,
          remoteJson: null,
        }),
      ),
    ).toBe("audio_clip");
  });

  it("uses a library clip for vocals even when the mix is a CDN Creation", () => {
    expect(parasceneProductTimelineAudioKind("vocals", audioCreation())).toBe(
      "audio_clip",
    );
  });

  it("uses the CDN window for full-mix Parascene audio", () => {
    expect(
      parasceneProductTimelineAudioKind("full_mix", audioCreation()),
    ).toBe("cdn_window");
  });

  it("is none when timeline audio is off", () => {
    expect(parasceneProductTimelineAudioKind("none", audioCreation())).toBe(
      "none",
    );
  });
});

describe("attachParasceneAudioClipId", () => {
  it("sends audio_clip_id and drops generic prompt-audio URLs", () => {
    const args: Record<string, unknown> = {
      input_audio_urls: [
        "https://www.parascene.com/api/images/generic/prompt-audio/26_x.webm",
      ],
      audio_url:
        "https://www.parascene.com/api/images/generic/prompt-audio/26_x.webm",
    };
    attachParasceneAudioClipId(args, "42");
    expect(args.audio_clip_id).toBe(42);
    expect(args).not.toHaveProperty("input_audio_urls");
    expect(args).not.toHaveProperty("audio_url");
  });

  it("rejects a missing clip id", () => {
    expect(() => attachParasceneAudioClipId({}, "")).toThrow(/clip id/i);
  });
});

describe("provider-fetchable audio URLs", () => {
  it("rejects generic prompt-audio (auth-gated)", () => {
    const url =
      "https://www.parascene.com/api/images/generic/prompt-audio/26_1788387432161_8tkfcfv.webm";
    expect(isGenericPromptAudioUrl(url)).toBe(true);
    expect(isProviderFetchableAudioUrl(url)).toBe(false);
  });

  it("rejects owner-only Creation audio redirects", () => {
    expect(
      isProviderFetchableAudioUrl(
        "https://www.parascene.com/api/create/images/27140/audio",
      ),
    ).toBe(false);
  });

  it("allows a share/clip-audio URL", () => {
    expect(
      isProviderFetchableAudioUrl(
        "https://www.parascene.com/api/share/v1/token/clip-audio",
      ),
    ).toBe(true);
  });
});
