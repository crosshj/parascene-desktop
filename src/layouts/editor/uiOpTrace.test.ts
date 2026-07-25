import { describe, expect, it } from "vitest";
import {
  clearUiOpTrace,
  formatUiOpTrace,
  getUiOpTrace,
  recordUiOpTrace,
} from "./uiOpTrace";

describe("uiOpTrace", () => {
  it("records post-place and render events", () => {
    clearUiOpTrace();
    recordUiOpTrace({
      type: "timeline_commit",
      count: 3,
      clipId: "c1",
      reason: "2->3 added=c1",
    });
    recordUiOpTrace({
      type: "add_asset_draft_patch",
      clipId: "c1",
      reason: "ok count=3",
    });
    recordUiOpTrace({
      type: "render_media_ensure_start",
      count: 1,
      ids: "19512",
    });
    const rows = getUiOpTrace();
    expect(rows).toHaveLength(3);
    expect(formatUiOpTrace()).toContain("timeline_commit");
    expect(formatUiOpTrace()).toContain("render_media_ensure_start");
    clearUiOpTrace();
    expect(getUiOpTrace()).toHaveLength(0);
  });

  it("caps the ring buffer", () => {
    clearUiOpTrace();
    for (let i = 0; i < 70; i += 1) {
      recordUiOpTrace({ type: `e${i}` });
    }
    const rows = getUiOpTrace();
    expect(rows).toHaveLength(60);
    expect(rows[0]?.type).toBe("e10");
    clearUiOpTrace();
  });
});
