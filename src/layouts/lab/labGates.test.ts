import { describe, expect, it } from "vitest";
import { labModuleGate, type LabGateContext } from "./labGates";

const ready: LabGateContext = {
  groupsReady: true,
  assetCount: 2,
  audioCount: 1,
  imageCount: 1,
  videoCount: 1,
  openAiReady: true,
  ffmpegReady: true,
  demucsReady: true,
  vocalsSliceReady: true,
};

describe("labModuleGate", () => {
  it("blocks a2v when demucs is missing", () => {
    const gate = labModuleGate("a2v", { ...ready, demucsReady: false });
    expect(gate?.navBlurb).toMatch(/Demucs/i);
    expect(gate?.action).toBe("settings");
  });

  it("blocks isolate when ffmpeg is missing", () => {
    const gate = labModuleGate("isolate", { ...ready, ffmpegReady: false });
    expect(gate?.navBlurb).toMatch(/FFmpeg/i);
    expect(gate?.action).toBe("settings");
  });

  it("allows isolate without demucs (slice-only)", () => {
    expect(labModuleGate("isolate", { ...ready, demucsReady: false })).toBeNull();
  });

  it("blocks a2v when vocals slice is missing", () => {
    const gate = labModuleGate("a2v", { ...ready, vocalsSliceReady: false });
    expect(gate?.navBlurb).toMatch(/vocals slice/i);
  });

  it("allows isolate when tools are ready", () => {
    expect(labModuleGate("isolate", ready)).toBeNull();
  });
});