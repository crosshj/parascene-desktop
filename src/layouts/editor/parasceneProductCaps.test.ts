import { describe, expect, it } from "vitest";
import productCaps from "../../../docs/parascene-product-server-caps.json";
import {
  formatParasceneCredits,
  parasceneBlueStillModels,
  parasceneIntentIsWired,
  parasceneMethodForIntent,
  parasceneReplicateImageModels,
  parasceneResolveStillModel,
  parasceneServerIdForIntent,
  parasceneStillModelEnumGroups,
  parasceneStillModelFamilies,
  parasceneStillModelsForIntent,
  parasceneVideoModels,
  parasceneVideoModelsForIntent,
  productCapsServerIds,
} from "./parasceneProductCaps";

describe("parasceneProductCaps", () => {
  it("orders product servers from caps metadata", () => {
    expect(productCapsServerIds()).toEqual([1, 6]);
    expect(JSON.stringify(productCaps)).not.toMatch(/auth_token/);
    expect(Object.keys(productCaps.servers ?? {}).sort()).toEqual(["1", "6"]);
  });

  it("maps video intents to server 6 Blue methods", () => {
    expect(parasceneServerIdForIntent("text_to_video")).toBe(6);
    expect(parasceneServerIdForIntent("video_to_video")).toBe(6);
    expect(parasceneServerIdForIntent("text_to_music")).toBeNull();
  });

  it("uses Blue method names for video", () => {
    expect(parasceneMethodForIntent("text_to_video")).toBe("text2video");
    expect(parasceneMethodForIntent("image_to_video")).toBe("image2video");
    expect(parasceneMethodForIntent("video_to_video")).toBe("video2video");
    expect(parasceneMethodForIntent("reference_to_video")).toBe(
      "reference2video",
    );
  });

  it("wires product-path intents from snapshot", () => {
    expect(parasceneIntentIsWired("text_to_image")).toBe(true);
    expect(parasceneIntentIsWired("image_to_image")).toBe(true);
    expect(parasceneIntentIsWired("text_to_video")).toBe(true);
    expect(parasceneIntentIsWired("image_to_video")).toBe(true);
    expect(parasceneIntentIsWired("image_audio_to_video")).toBe(true);
    expect(parasceneIntentIsWired("video_to_video")).toBe(true);
    expect(parasceneIntentIsWired("reference_to_video")).toBe(true);
    expect(parasceneIntentIsWired("text_to_music")).toBe(false);
    expect(parasceneIntentIsWired("text_to_speech")).toBe(false);
  });

  it("formats credit labels from method caps", () => {
    expect(formatParasceneCredits(1)).toBe("1 credit");
    expect(formatParasceneCredits(3)).toBe("3 credits");
    expect(formatParasceneCredits(0.1)).toBe("0.1 credits");
  });

  it("merges Blue and Replicate still models for Parascene T2I", () => {
    const t2i = parasceneStillModelsForIntent("text_to_image");
    expect(t2i.length).toBeGreaterThan(10);
    expect(t2i.some((m) => m.family === "blue")).toBe(true);
    expect(t2i.some((m) => m.family === "replicate")).toBe(true);
    expect(t2i.some((m) => m.family === "replicate_pro")).toBe(true);
    expect(t2i.some((m) => m.family === "pixellab")).toBe(true);

    const families = parasceneStillModelFamilies("text_to_image");
    expect(families.map((f) => f.label)).toEqual([
      "Replicate (3 credits)",
      "Replicate Pro (15 credits)",
      "PixelLab (0.2 credits)",
      "Blue (0.1 credits)",
    ]);
    const groups = parasceneStillModelEnumGroups("text_to_image");
    expect(groups.map((g) => g.label)).toEqual(families.map((f) => f.label));
    expect(groups[0]?.values[0]).toBe(families[0]?.models[0]?.id);
    expect(groups[groups.length - 1]?.values.length).toBeGreaterThan(1);
    expect(parasceneStillModelsForIntent("text_to_image")[0]?.family).toBe(
      "replicate",
    );
  });

  it("filters Replicate I2I models to input-capable options", () => {
    const i2i = parasceneStillModelsForIntent("image_to_image");
    expect(i2i.some((m) => m.family === "blue")).toBe(true);
    expect(i2i.some((m) => m.family === "replicate")).toBe(true);
    expect(i2i.some((m) => m.family === "pixellab")).toBe(false);
    expect(
      i2i.some(
        (m) =>
          m.family === "replicate" &&
          m.value === "prunaai/p-image",
      ),
    ).toBe(false);
  });

  it("resolves still routes across server 1 and 6", () => {
    const blue = parasceneStillModelsForIntent("text_to_image").find(
      (m) => m.family === "blue",
    );
    expect(blue).toBeTruthy();
    expect(parasceneResolveStillModel("text_to_image", blue!.id)?.serverId).toBe(
      6,
    );

    const replicate = parasceneStillModelsForIntent("text_to_image").find(
      (m) => m.family === "replicate",
    );
    expect(replicate).toBeTruthy();
    expect(
      parasceneResolveStillModel("text_to_image", replicate!.id)?.serverId,
    ).toBe(1);
    expect(
      parasceneResolveStillModel("text_to_image", replicate!.id)?.method,
    ).toBe("replicate");
  });

  it("lists legacy helpers", () => {
    expect(parasceneBlueStillModels("text2image").length).toBeGreaterThan(0);
    expect(parasceneReplicateImageModels().length).toBeGreaterThan(0);
  });

  it("lists video models per intent", () => {
    const t2v = parasceneVideoModelsForIntent("text_to_video");
    expect(t2v.some((m) => m.id === "wan_t2v")).toBe(true);
    const v2v = parasceneVideoModelsForIntent("video_to_video");
    expect(v2v.some((m) => m.id === "bernini_r_v2v" || m.id === "wan_animate")).toBe(
      true,
    );
    const r2v = parasceneVideoModelsForIntent("reference_to_video");
    expect(r2v.some((m) => m.id === "minimax_r2v")).toBe(true);
    expect(parasceneVideoModels().length).toBeGreaterThan(3);
  });
});
