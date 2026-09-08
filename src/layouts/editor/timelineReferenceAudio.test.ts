import { describe, expect, it } from "vitest";
import type { Creation } from "../../library/types";
import type { TimelineClip } from "../../project/types";
import {
  attachParasceneAudioClipId,
  isGenericPromptAudioUrl,
  isProviderFetchableAudioUrl,
  monitorBakePathForGenerateSlice,
  parasceneProductTimelineAudioKind,
  placeholderNeedsCombinedTimelineAudio,
  placeholderTimelineAudioWindow,
  timelineReferenceAudioClip,
  timelineReferenceVolumeGain,
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

  it("forces a local clip when A1+A2 must be mixed", () => {
    expect(
      parasceneProductTimelineAudioKind("full_mix", audioCreation(), 100, true),
    ).toBe("audio_clip");
  });

  it("forces a local clip when the covering instance is not unity", () => {
    expect(
      parasceneProductTimelineAudioKind("full_mix", audioCreation(), 40),
    ).toBe("audio_clip");
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

describe("monitorBakePathForGenerateSlice", () => {
  it("reuses the monitor bake and does not treat blank as a path", () => {
    expect(monitorBakePathForGenerateSlice("/tmp/timeline-audio/mix.wav")).toBe(
      "/tmp/timeline-audio/mix.wav",
    );
    expect(monitorBakePathForGenerateSlice("  ")).toBeNull();
    expect(monitorBakePathForGenerateSlice(null)).toBeNull();
  });
});

describe("placeholderNeedsCombinedTimelineAudio", () => {
  function audioClip(
    partial: Partial<TimelineClip> & Pick<TimelineClip, "id" | "startSec" | "endSec">,
  ): TimelineClip {
    return {
      label: partial.label ?? partial.id,
      lane: "audio",
      kind: "audio",
      assetId: partial.assetId ?? partial.id,
      ...partial,
    };
  }

  it("is true when A1 speech and A2 bed overlap the generate window", () => {
    const timeline = [
      audioClip({
        id: "a1",
        assetId: "speech",
        startSec: 3.2,
        endSec: 5.65,
      }),
      audioClip({
        id: "a2",
        assetId: "music",
        startSec: 0,
        endSec: 11.3,
        audioTrack: 2,
        volume: 8,
      }),
    ];
    const placeholder: TimelineClip = {
      id: "ph",
      label: "3.8s",
      startSec: 3.1,
      endSec: 6.9,
      isAddAssetPlaceholder: true,
    };
    expect(placeholderNeedsCombinedTimelineAudio(timeline, placeholder)).toBe(
      true,
    );
    expect(placeholderTimelineAudioWindow(placeholder)).toEqual({
      startSec: 3.1,
      endSec: 6.9,
      durationSec: 3.8,
    });
  });

  it("is false when only one A1 clip covers the window", () => {
    const timeline = [
      audioClip({ id: "a1", startSec: 0, endSec: 20 }),
    ];
    const placeholder: TimelineClip = {
      id: "ph",
      label: "9.0s",
      startSec: 2,
      endSec: 11,
      isAddAssetPlaceholder: true,
    };
    expect(placeholderNeedsCombinedTimelineAudio(timeline, placeholder)).toBe(
      false,
    );
  });

  it("is true for A2 alone in the window", () => {
    const timeline = [
      audioClip({
        id: "a2",
        startSec: 0,
        endSec: 20,
        audioTrack: 2,
      }),
    ];
    const placeholder: TimelineClip = {
      id: "ph",
      label: "9.0s",
      startSec: 2,
      endSec: 11,
      isAddAssetPlaceholder: true,
    };
    expect(placeholderNeedsCombinedTimelineAudio(timeline, placeholder)).toBe(
      true,
    );
  });
});

describe("timelineReferenceAudioClip", () => {
  function audioClip(
    partial: Partial<TimelineClip> & Pick<TimelineClip, "id" | "startSec" | "endSec">,
  ): TimelineClip {
    return {
      label: partial.label ?? partial.id,
      lane: "audio",
      kind: "audio",
      assetId: "song",
      ...partial,
    };
  }

  it("uses the instance covering the placeholder when the same asset is placed twice", () => {
    const timeline = [
      audioClip({ id: "quiet", startSec: 0, endSec: 10, volume: 40 }),
      audioClip({ id: "loud", startSec: 12, endSec: 22, volume: 100 }),
    ];
    const placeholder: TimelineClip = {
      id: "ph",
      label: "9.0s",
      startSec: 2,
      endSec: 11,
      isAddAssetPlaceholder: true,
    };
    expect(
      timelineReferenceAudioClip(timeline, placeholder, "song")?.id,
    ).toBe("quiet");
    expect(
      timelineReferenceVolumeGain(timeline, placeholder, "song"),
    ).toBeCloseTo(0.4);
  });
});
