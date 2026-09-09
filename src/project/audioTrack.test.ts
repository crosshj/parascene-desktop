import { describe, expect, it } from "vitest";
import {
  clipAudioTrack,
  clipsOnAudioTrack,
  normalizeAudioTrack,
  persistAudioTrack,
} from "./audioTrack";

describe("audioTrack", () => {
  it("defaults omitted and 1 to A1", () => {
    expect(clipAudioTrack({})).toBe(1);
    expect(clipAudioTrack({ audioTrack: 1 })).toBe(1);
    expect(normalizeAudioTrack(1)).toBeUndefined();
    expect(persistAudioTrack({})).toBeUndefined();
  });

  it("keeps A2 unless the clip is linked video audio", () => {
    expect(clipAudioTrack({ audioTrack: 2 })).toBe(2);
    expect(persistAudioTrack({ audioTrack: 2 })).toBe(2);
    expect(
      clipAudioTrack({ audioTrack: 2, linkedVideoClipId: "vid" }),
    ).toBe(1);
    expect(
      persistAudioTrack({ audioTrack: 2, linkedVideoClipId: "vid" }),
    ).toBeUndefined();
  });

  it("filters clips on one audio track", () => {
    const clips = [
      { id: "a1", lane: "audio" as const },
      { id: "a2", lane: "audio" as const, audioTrack: 2 as const },
      { id: "v", lane: "video" as const, audioTrack: 2 as const },
    ];
    expect(clipsOnAudioTrack(clips, 1).map((c) => c.id)).toEqual(["a1"]);
    expect(clipsOnAudioTrack(clips, 2).map((c) => c.id)).toEqual(["a2"]);
  });
});
