import { describe, expect, it } from "vitest";
import {
  clipLane,
  laneAppendStartSec,
  pasteAppendStartSec,
} from "./timelineAppend";

describe("timelineAppend", () => {
  it("appends at 0 on an empty lane", () => {
    expect(laneAppendStartSec([])).toBe(0);
  });

  it("appends after the latest end on the lane", () => {
    expect(
      laneAppendStartSec([
        { startSec: 0, endSec: 4 },
        { startSec: 6, endSec: 10 },
        { startSec: 2, endSec: 3 },
      ]),
    ).toBe(10);
  });

  it("pastes a single clip after its lane end", () => {
    expect(
      pasteAppendStartSec(
        [
          { startSec: 0, endSec: 5, lane: "video" },
          { startSec: 0, endSec: 20, lane: "audio" },
        ],
        [{ startSec: 0, endSec: 3, lane: "video" }],
      ),
    ).toBe(5);
  });

  it("keeps relative offsets and clears both lanes", () => {
    // Video ends at 5; audio ends at 12. Clipboard has video at 0 and audio at 2.
    // startBase must be >= 5 and >= 12-2=10 → 10.
    expect(
      pasteAppendStartSec(
        [
          { startSec: 0, endSec: 5, lane: "video" },
          { startSec: 0, endSec: 12, lane: "audio" },
        ],
        [
          { startSec: 0, endSec: 3, lane: "video" },
          { startSec: 2, endSec: 5, lane: "audio" },
        ],
      ),
    ).toBe(10);
  });

  it("defaults missing lane to video", () => {
    expect(clipLane({})).toBe("video");
    expect(clipLane({ lane: "audio" })).toBe("audio");
  });
});
