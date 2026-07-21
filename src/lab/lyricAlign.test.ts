import { describe, expect, it } from "vitest";
import {
  alignLyricsHeuristic,
  parseLyricLines,
} from "./lyricAlign";

describe("lyricAlign", () => {
  it("parses non-empty lyric lines", () => {
    expect(parseLyricLines("  hello \n\nworld ")).toEqual(["hello", "world"]);
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
});
