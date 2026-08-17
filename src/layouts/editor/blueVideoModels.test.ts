import { describe, expect, it } from "vitest";
import {
  blueMethodForTimelineFill,
  expandLegacyBlueModelId,
  filterBlueVideoModels,
  pickCompatibleBlueModel,
  resolveBlueVideoModelId,
  type BlueVideoModelOption,
} from "./blueVideoModels";

const MODELS: BlueVideoModelOption[] = [
  {
    id: "wan_t2v",
    label: "Wan t2v",
    method: "text2video",
    flf: false,
    nativeAudio: false,
  },
  {
    id: "ltx_t2v",
    label: "LTX t2v",
    method: "text2video",
    flf: false,
    nativeAudio: true,
  },
  {
    id: "minimax_t2v",
    label: "MiniMax H3 t2v",
    method: "text2video",
    flf: false,
    nativeAudio: true,
  },
  {
    id: "wan_i2v",
    label: "Wan i2v",
    method: "image2video",
    flf: true,
    nativeAudio: false,
  },
  {
    id: "ltx_i2v",
    label: "LTX i2v",
    method: "image2video",
    flf: true,
    nativeAudio: true,
  },
  {
    id: "minimax_i2v",
    label: "MiniMax H3 i2v",
    method: "image2video",
    flf: true,
    nativeAudio: true,
  },
  {
    id: "ltx_style_transition",
    label: "LTX style",
    method: "image2video",
    flf: true,
    nativeAudio: true,
  },
  {
    id: "ltx_a2v",
    label: "LTX a2v",
    method: "audio2video",
    flf: false,
    nativeAudio: true,
  },
];

describe("blueVideoModels", () => {
  it("maps continuity + audio to Blue methods", () => {
    expect(
      blueMethodForTimelineFill({ continuity: "none", audioMode: "none" }),
    ).toBe("text2video");
    expect(
      blueMethodForTimelineFill({
        continuity: "start_frame",
        audioMode: "none",
      }),
    ).toBe("image2video");
    expect(
      blueMethodForTimelineFill({
        continuity: "start_frame",
        audioMode: "full_mix",
      }),
    ).toBe("audio2video");
    expect(
      blueMethodForTimelineFill({
        continuity: "first_last",
        audioMode: "none",
      }),
    ).toBe("image2video");
  });

  it("expands legacy wan/ltx aliases", () => {
    expect(expandLegacyBlueModelId("wan", "image2video")).toBe("wan_i2v");
    expect(expandLegacyBlueModelId("ltx", "audio2video")).toBe("ltx_a2v");
    expect(expandLegacyBlueModelId("minimax_i2v", "image2video")).toBe(
      "minimax_i2v",
    );
  });

  it("includes MiniMax on Direct to Blue image2video", () => {
    const list = filterBlueVideoModels({
      models: MODELS,
      method: "image2video",
      continuity: "start_frame",
      blueDirect: true,
    });
    expect(list.map((m) => m.id)).toContain("minimax_i2v");
    expect(list.map((m) => m.id)).not.toContain("ltx_style_transition");
  });

  it("hides MiniMax on Parascene Creation path", () => {
    const list = filterBlueVideoModels({
      models: MODELS,
      method: "image2video",
      continuity: "start_frame",
      blueDirect: false,
    });
    expect(list.map((m) => m.id)).toEqual(["wan_i2v", "ltx_i2v"]);
  });

  it("keeps flf models for first+last", () => {
    const picked = pickCompatibleBlueModel({
      models: MODELS,
      method: "image2video",
      continuity: "first_last",
      blueDirect: true,
      preferredId: "minimax_i2v",
    });
    expect(picked?.id).toBe("minimax_i2v");
  });

  it("resolves default LTX i2v for start frame", () => {
    expect(
      resolveBlueVideoModelId({
        selected: null,
        method: "image2video",
        continuity: "start_frame",
        blueDirect: true,
        models: MODELS,
      }),
    ).toBe("ltx_i2v");
  });
});
