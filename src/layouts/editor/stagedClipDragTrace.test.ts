import { describe, expect, it } from "vitest";
import {
  clearStagedClipDragTrace,
  formatStagedClipDragTrace,
  getStagedClipDragTrace,
  recordStagedClipDragTrace,
} from "./stagedClipDragTrace";

describe("stagedClipDragTrace", () => {
  it("records a ring buffer of release-gap events", () => {
    clearStagedClipDragTrace();
    recordStagedClipDragTrace({ type: "drag_armed", kind: "image" });
    recordStagedClipDragTrace({
      type: "pointerup",
      x: 10,
      y: 20,
      drop: true,
    });
    recordStagedClipDragTrace({
      type: "reject_not_over_tracks",
      reason: "outside",
      overTracks: false,
    });
    const rows = getStagedClipDragTrace();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.type).toBe("drag_armed");
    expect(rows[2]?.overTracks).toBe(false);

    const text = formatStagedClipDragTrace();
    expect(text).toContain("drag_armed");
    expect(text).toContain("reject_not_over_tracks");
    clearStagedClipDragTrace();
    expect(getStagedClipDragTrace()).toHaveLength(0);
  });

  it("caps the ring buffer length", () => {
    clearStagedClipDragTrace();
    for (let i = 0; i < 50; i += 1) {
      recordStagedClipDragTrace({ type: `e${i}` });
    }
    const rows = getStagedClipDragTrace();
    expect(rows).toHaveLength(40);
    expect(rows[0]?.type).toBe("e10");
    expect(rows[39]?.type).toBe("e49");
    clearStagedClipDragTrace();
  });
});
