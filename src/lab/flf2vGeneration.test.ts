import { describe, expect, it } from "vitest";
import {
  buildFlf2vCreateArgs,
  FLF2V_MODEL,
} from "../lab/flf2vGeneration";

describe("buildFlf2vCreateArgs", () => {
  it("uses wan_i2v with first then last image urls", () => {
    const args = buildFlf2vCreateArgs({
      prompt: "  morph between shots  ",
      aspectRatio: "16:9",
      firstImageUrl: "https://example.com/first.jpg",
      lastImageUrl: "https://example.com/last.jpg",
      durationSeconds: 5,
    });
    expect(args).toEqual({
      prompt: "morph between shots",
      model: FLF2V_MODEL,
      aspect_ratio: "16:9",
      input_images: [
        "https://example.com/first.jpg",
        "https://example.com/last.jpg",
      ],
      duration_seconds: 5,
    });
    expect(args.input_images[0]).toBe("https://example.com/first.jpg");
    expect(args.input_images[1]).toBe("https://example.com/last.jpg");
    expect(args.model).toBe("wan_i2v");
  });

  it("omits duration when unset", () => {
    const args = buildFlf2vCreateArgs({
      prompt: "bridge",
      aspectRatio: "9:16",
      firstImageUrl: "https://example.com/a.jpg",
      lastImageUrl: "https://example.com/b.jpg",
    });
    expect(args.duration_seconds).toBeUndefined();
  });
});
