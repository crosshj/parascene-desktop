import { describe, expect, it } from "vitest";
import {
  buildBlueT2vCreateArgs,
  LTX_T2V_MODEL,
  WAN_T2V_MODEL,
} from "./blueT2vGeneration";

describe("buildBlueT2vCreateArgs", () => {
  it("builds wan_t2v args without images", () => {
    const args = buildBlueT2vCreateArgs({
      prompt: "  a bird over water  ",
      aspectRatio: "16:9",
      model: WAN_T2V_MODEL,
      durationSeconds: 5,
    });
    expect(args).toEqual({
      prompt: "a bird over water",
      model: WAN_T2V_MODEL,
      aspect_ratio: "16:9",
      duration_seconds: 5,
    });
    expect(args.model).toBe("wan_t2v");
  });

  it("builds ltx_t2v args without images", () => {
    const args = buildBlueT2vCreateArgs({
      prompt: "slow pan across a room",
      aspectRatio: "9:16",
      model: LTX_T2V_MODEL,
      durationSeconds: 4,
    });
    expect(args).toEqual({
      prompt: "slow pan across a room",
      model: LTX_T2V_MODEL,
      aspect_ratio: "9:16",
      duration_seconds: 4,
    });
  });

  it("omits duration when unset", () => {
    const args = buildBlueT2vCreateArgs({
      prompt: "abstract motion",
      aspectRatio: "1:1",
      model: LTX_T2V_MODEL,
    });
    expect(args.duration_seconds).toBeUndefined();
  });
});
