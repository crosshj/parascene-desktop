import { describe, expect, it } from "vitest";
import {
  formatClipDurationCompact,
  lyricBlockLabel,
  timelineClipLayoutTier,
} from "./timelineClipDisplay";

describe("timelineClipDisplay", () => {
  it("picks layout tier from clip width", () => {
    expect(timelineClipLayoutTier(80)).toBe("wide");
    expect(timelineClipLayoutTier(40)).toBe("compact");
    expect(timelineClipLayoutTier(8)).toBe("sliver");
  });

  it("shortens duration labels on narrow clips", () => {
    expect(formatClipDurationCompact(8.8, 60)).toBe("8.8s");
    expect(formatClipDurationCompact(8.8, 18)).toBe("9");
    expect(formatClipDurationCompact(8.8, 8)).toBeNull();
  });

  it("avoids empty lyric labels on very narrow blocks", () => {
    expect(lyricBlockLabel("Hey, baby", 60)).toBe("Hey, baby");
    expect(lyricBlockLabel("Hey, baby", 24)).toBe("Hey,");
    expect(lyricBlockLabel("Hey, baby", 12)).toBe("H");
    expect(lyricBlockLabel("Hey, baby", 6)).toBe("·");
  });
});
