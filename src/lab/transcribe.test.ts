import { describe, expect, it } from "vitest";
import { filterWordsByVocalPeaks, type TranscriptWord } from "./transcribe";

describe("filterWordsByVocalPeaks", () => {
  const durationSec = 100;
  const peaks = Array.from({ length: 100 }, (_, i) => (i < 50 ? 0.8 : 0.01));

  it("drops words in the silent tail", () => {
    const words: TranscriptWord[] = [
      { word: "sing", startSec: 10, endSec: 12 },
      { word: "thank", startSec: 80, endSec: 82 },
    ];
    const filtered = filterWordsByVocalPeaks(words, peaks, durationSec);
    expect(filtered.map((w) => w.word)).toEqual(["sing"]);
  });

  it("drops words in a silent gap between vocal regions", () => {
    const gapPeaks = Array.from({ length: 100 }, (_, i) => {
      if (i < 30) return 0.9;
      if (i < 70) return 0.01;
      return 0.9;
    });
    const words: TranscriptWord[] = [
      { word: "hey", startSec: 5, endSec: 8 },
      { word: "ghost", startSec: 40, endSec: 45 },
      { word: "again", startSec: 85, endSec: 88 },
    ];
    const filtered = filterWordsByVocalPeaks(words, gapPeaks, durationSec);
    expect(filtered.map((w) => w.word)).toEqual(["hey", "again"]);
  });
});
