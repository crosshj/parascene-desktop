import { describe, expect, it } from "vitest";
import { pickBlueStillModel, type BlueStillModelOption } from "./blueStillModels";

const MODELS: BlueStillModelOption[] = [
  { id: "other/model.safetensors", label: "other" },
  {
    id: "diffusion_models/flux/flux1-dev.safetensors",
    label: "flux: flux1-dev",
  },
];

describe("blueStillModels", () => {
  it("prefers an explicit selection", () => {
    expect(pickBlueStillModel(MODELS, "other/model.safetensors")?.id).toBe(
      "other/model.safetensors",
    );
  });

  it("defaults to flux1-dev when present", () => {
    expect(pickBlueStillModel(MODELS, null)?.id).toBe(
      "diffusion_models/flux/flux1-dev.safetensors",
    );
  });
});
