import { describe, expect, it } from "vitest";
import {
  lyricsInTimeRange,
  lyricsTextInTimeRange,
  matchingLyricAlignment,
  resolveLyricsForTimeRange,
} from "./addAssetLyrics";

describe("addAssetLyrics", () => {
  const lines = [
    { line: "[Intro]", startSec: 0, endSec: 2, inaudible: true },
    { line: "First line", startSec: 2, endSec: 5 },
    { line: "Second line", startSec: 8, endSec: 11 },
  ];

  it("returns sung lines overlapping the clip window", () => {
    expect(lyricsInTimeRange(lines, 4, 9)).toEqual([
      { line: "First line", startSec: 2, endSec: 5 },
      { line: "Second line", startSec: 8, endSec: 11 },
    ]);
  });

  it("joins overlapping lyrics as text", () => {
    expect(lyricsTextInTimeRange(lines, 8, 11)).toBe("Second line");
  });
});

describe("matchingLyricAlignment", () => {
  const alignment = {
    sourceAudioCreationId: "audio-a",
    lyricsText: "x",
    alignedAt: "",
    transcribeEngine: "openai" as const,
    lines: [],
  };

  it("returns alignment when present", () => {
    expect(matchingLyricAlignment(alignment)).toBe(alignment);
  });
});

describe("resolveLyricsForTimeRange", () => {
  it("falls back to transcript segments when aligned lines are empty", () => {
    const alignment = {
      sourceAudioCreationId: "audio-a",
      lyricsText: "Line one",
      alignedAt: "now",
      transcribeEngine: "openai" as const,
      lines: [],
      transcript: {
        engine: "openai" as const,
        transcribedAt: "now",
        vocalsPath: "/tmp/v.wav",
        fullText: "Line one",
        segments: [{ text: "Line one", startSec: 100, endSec: 104 }],
      },
    };
    expect(resolveLyricsForTimeRange(alignment, 101, 110)).toBe("Line one");
  });
});
