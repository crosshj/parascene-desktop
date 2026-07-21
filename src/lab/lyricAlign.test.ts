import { describe, expect, it } from "vitest";
import {
  alignLyricsFromWords,
  alignLyricsHeuristic,
  enforceNonOverlappingAlignedLines,
  isInaudibleLyricText,
  isSunoTagLine,
  mergeAlignedLyricsWithTags,
  parseLyricLines,
  parseLyricScript,
  reconcileAlignedLinesFromScript,
  selectWordsForVocalBlock,
} from "./lyricAlign";
import type { TranscriptWord } from "./transcribe";

describe("lyricAlign", () => {
  it("parses non-empty lyric lines", () => {
    expect(parseLyricLines("  hello \n\nworld ")).toEqual(["hello", "world"]);
  });

  it("detects Suno bracket tags", () => {
    expect(isSunoTagLine("[Intro]")).toBe(true);
    expect(isSunoTagLine("[Verse 1]")).toBe(true);
    expect(isSunoTagLine("not a tag")).toBe(false);
  });

  it("splits script into grouped tags and singable lines", () => {
    expect(
      parseLyricScript("[Intro]\n[Build]\nHello there\n[Chorus]\nSing it"),
    ).toEqual([
      { kind: "tag", text: "[Intro]\n[Build]" },
      { kind: "line", text: "Hello there" },
      { kind: "tag", text: "[Chorus]" },
      { kind: "line", text: "Sing it" },
    ]);
    expect(parseLyricLines("[Intro]\nHello there")).toEqual(["Hello there"]);
  });

  it("supports multi-line bracket tags", () => {
    expect(parseLyricScript("[Intro\nsoft fade]\nHello")).toEqual([
      { kind: "tag", text: "[Intro\nsoft fade]" },
      { kind: "line", text: "Hello" },
    ]);
  });

  it("reclassifies old alignments that timed Suno tags as segments", () => {
    const lyrics = "[Intro]\nHey, baby\n[Chorus]\nSing it";
    const stale = [
      { line: "[Intro]", startSec: 0, endSec: 2, confidence: 0.99 },
      { line: "Hey, baby", startSec: 2, endSec: 6, confidence: 0.95 },
      { line: "[Chorus]", startSec: 6, endSec: 8, confidence: 0.9 },
      { line: "Sing it", startSec: 8, endSec: 10, confidence: 0.88 },
    ];
    const fixed = reconcileAlignedLinesFromScript(lyrics, stale);
    expect(fixed[0]).toMatchObject({
      line: "[Intro]",
      inaudible: true,
      startSec: 2,
      endSec: 2,
    });
    expect(fixed[0].confidence).toBeUndefined();
    expect(fixed[1]).toMatchObject({
      line: "Hey, baby",
      startSec: 2,
      endSec: 6,
    });
    expect(isInaudibleLyricText("[Intro]")).toBe(true);
  });

  it("merges aligned singable lines with inaudible tags", () => {
    const script = parseLyricScript("[Intro]\nLine one\n[Chorus]\nLine two");
    const aligned = alignLyricsHeuristic({
      lines: ["Line one", "Line two"],
      segments: [
        { text: "line one", startSec: 0, endSec: 1.5 },
        { text: "line two", startSec: 1.5, endSec: 3 },
      ],
      durationSec: 3,
    });
    const merged = mergeAlignedLyricsWithTags(script, aligned, 3);
    expect(merged).toHaveLength(4);
    expect(merged[0]).toMatchObject({
      line: "[Intro]",
      inaudible: true,
      startSec: 0,
      endSec: 0,
    });
    expect(merged[1]).toMatchObject({ line: "Line one", inaudible: false });
    expect(merged[2]).toMatchObject({
      line: "[Chorus]",
      inaudible: true,
      startSec: merged[1].endSec,
    });
  });

  it("aligns lyric lines from Whisper word timings", () => {
    const words: TranscriptWord[] = [
      { word: "Hey", startSec: 2.0, endSec: 2.3 },
      { word: "baby", startSec: 2.3, endSec: 2.7 },
      { word: "do", startSec: 2.7, endSec: 2.9 },
      { word: "you", startSec: 2.9, endSec: 3.1 },
      { word: "like", startSec: 3.1, endSec: 3.4 },
      { word: "me", startSec: 3.4, endSec: 3.8 },
      { word: "getting", startSec: 4.0, endSec: 4.4 },
      { word: "higher", startSec: 4.4, endSec: 4.9 },
    ];
    const aligned = alignLyricsFromWords({
      lines: ["Hey, baby, do you like me", "getting higher"],
      words,
      durationSec: 10,
    });
    expect(aligned[0].startSec).toBe(2);
    expect(aligned[0].endSec).toBeCloseTo(3.8, 1);
    expect(aligned[1].startSec).toBeCloseTo(4, 1);
    expect(aligned[1].endSec).toBeCloseTo(4.9, 1);
  });

  it("heuristically maps lines onto transcript segments", () => {
    const aligned = alignLyricsHeuristic({
      lines: ["first line", "second line"],
      segments: [
        { text: "first", startSec: 0, endSec: 1.2 },
        { text: "line here", startSec: 1.2, endSec: 2.4 },
        { text: "second line now", startSec: 2.4, endSec: 4 },
      ],
      durationSec: 4,
    });
    expect(aligned).toHaveLength(2);
    expect(aligned[0].startSec).toBe(0);
    expect(aligned[1].startSec).toBeGreaterThanOrEqual(aligned[0].endSec);
  });

  it("snaps preceding block ends to the next block start when AI overlaps", () => {
    const fixed = enforceNonOverlappingAlignedLines(
      [
        { line: "line one", startSec: 0, endSec: 15, confidence: 0.9 },
        { line: "line two", startSec: 8, endSec: 20, confidence: 0.9 },
        { line: "line three", startSec: 18, endSec: 30, confidence: 0.9 },
      ],
      60,
    );
    expect(fixed[0].endSec).toBe(8);
    expect(fixed[1].endSec).toBe(18);
    expect(fixed[2].startSec).toBe(18);
    expect(fixed[2].endSec).toBe(30);
    expect(fixed[0].endSec).toBeLessThanOrEqual(fixed[1].startSec);
    expect(fixed[1].endSec).toBeLessThanOrEqual(fixed[2].startSec);
  });

  it("preserves block ends when the next line starts later", () => {
    const fixed = enforceNonOverlappingAlignedLines([
      { line: "line one", startSec: 0, endSec: 10, confidence: 0.9 },
      { line: "line two", startSec: 12, endSec: 20, confidence: 0.9 },
    ]);
    expect(fixed[0].endSec).toBe(10);
    expect(fixed[1].startSec).toBe(12);
    expect(fixed[1].endSec).toBe(20);
  });

  it("selects whisper words that overlap a vocal block", () => {
    const words: TranscriptWord[] = [
      { word: "one", startSec: 1, endSec: 1.5 },
      { word: "two", startSec: 1.5, endSec: 2 },
      { word: "three", startSec: 5, endSec: 5.5 },
      { word: "four", startSec: 5.5, endSec: 6 },
    ];
    expect(
      selectWordsForVocalBlock(words, { startSec: 0, endSec: 3 }).map(
        (w) => w.word,
      ),
    ).toEqual(["one", "two"]);
  });
});
