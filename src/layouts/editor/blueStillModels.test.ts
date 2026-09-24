import { describe, expect, it } from "vitest";
import {
  loadBlueStillModels,
  pickBlueStillModel,
  type BlueStillModelOption,
} from "./blueStillModels";

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

  it("uses newly pulled models from the checked-in Blue snapshot", async () => {
    const models = await loadBlueStillModels("text2image");
    expect(models.map((model) => model.id)).toContain(
      "diffusion_models/krea2/krea2_turbo_fp8_scaled.safetensors",
    );
  });
});
