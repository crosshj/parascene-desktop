import { describe, expect, it } from "vitest";
import { previewVolumeRole } from "./previewVolumeRole";

describe("previewVolumeRole", () => {
  it("uses the timeline master when the monitor owns the preview", () => {
    expect(
      previewVolumeRole({
        monitorMode: "timeline",
        editingClip: true,
        clip: { kind: "audio", lane: "audio" },
      }),
    ).toBe("monitor");
  });

  it("binds instance volume only for a selected timeline audio clip", () => {
    expect(
      previewVolumeRole({
        monitorMode: "source",
        editingClip: true,
        clip: { kind: "audio", lane: "audio" },
      }),
    ).toBe("clip_instance");
  });

  it("treats an Assets-panel audio pick as listen-only", () => {
    expect(
      previewVolumeRole({
        monitorMode: "source",
        editingClip: false,
        clip: { kind: "audio", lane: "audio" },
      }),
    ).toBe("source_listen");
  });

  it("does not write instance volume for a selected video clip", () => {
    expect(
      previewVolumeRole({
        monitorMode: "source",
        editingClip: true,
        clip: { kind: "video", lane: "video" },
      }),
    ).toBe("source_listen");
  });
});
