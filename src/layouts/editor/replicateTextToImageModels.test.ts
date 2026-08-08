import { describe, expect, it } from "vitest";
import type {
  ReplicateInputField,
  ReplicateModelDetail,
} from "../../replicate/replicateClient";
import { modelSupportsTextToImage } from "./replicateTextToImageModels";

function field(
  partial: Partial<ReplicateInputField> & { name: string },
): ReplicateInputField {
  const { name, ...rest } = partial;
  return {
    name,
    typeName: partial.typeName ?? "string",
    required: partial.required ?? false,
    fileLike: partial.fileLike ?? false,
    arrayItemFileLike: partial.arrayItemFileLike ?? false,
    ...rest,
  };
}

function detail(
  partial: Partial<ReplicateModelDetail> & {
    inputs: ReplicateInputField[];
    raw: unknown;
  },
): Pick<
  ReplicateModelDetail,
  "raw" | "name" | "description" | "features" | "inputs" | "schemaCached"
> {
  return {
    raw: partial.raw,
    name: partial.name ?? "test-model",
    description: partial.description ?? "Generate an image from a prompt",
    features: partial.features ?? ["image", "prompt"],
    inputs: partial.inputs,
    schemaCached: partial.schemaCached ?? true,
  };
}

const imageUriOutput = {
  default_example: { output: ["https://cdn.test/result.webp"] },
};

describe("modelSupportsTextToImage", () => {
  it("accepts prompt-only image models", () => {
    expect(
      modelSupportsTextToImage(
        detail({
          inputs: [
            field({ name: "prompt", required: true }),
            field({ name: "aspect_ratio", typeName: "string" }),
          ],
          raw: imageUriOutput,
        }),
      ),
    ).toBe(true);
  });

  it("accepts models with optional image input", () => {
    expect(
      modelSupportsTextToImage(
        detail({
          inputs: [
            field({ name: "prompt", required: true }),
            field({ name: "image", fileLike: true, required: false }),
          ],
          raw: imageUriOutput,
        }),
      ),
    ).toBe(true);
  });

  it("rejects models that require an image input", () => {
    expect(
      modelSupportsTextToImage(
        detail({
          description: "Edit an image",
          features: ["image", "image_in", "prompt"],
          inputs: [
            field({ name: "prompt", required: true }),
            field({ name: "image", fileLike: true, required: true }),
          ],
          raw: imageUriOutput,
        }),
      ),
    ).toBe(false);
  });

  it("rejects models without a prompt field", () => {
    expect(
      modelSupportsTextToImage(
        detail({
          inputs: [field({ name: "seed", typeName: "integer" })],
          raw: imageUriOutput,
        }),
      ),
    ).toBe(false);
  });

  it("rejects video-output models", () => {
    expect(
      modelSupportsTextToImage(
        detail({
          description: "Text to video",
          features: ["video", "prompt"],
          inputs: [field({ name: "prompt", required: true })],
          raw: {
            default_example: { output: "https://cdn.test/result.mp4" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects models that require a video input", () => {
    expect(
      modelSupportsTextToImage(
        detail({
          description: "Stylize a video frame as an image",
          features: ["image", "video_in", "prompt"],
          inputs: [
            field({ name: "prompt", required: true }),
            field({
              name: "video",
              fileLike: true,
              required: true,
              description: "Source video",
            }),
          ],
          raw: imageUriOutput,
        }),
      ),
    ).toBe(false);
  });

  it("rejects uncached schemas", () => {
    expect(
      modelSupportsTextToImage(
        detail({
          schemaCached: false,
          inputs: [field({ name: "prompt", required: true })],
          raw: imageUriOutput,
        }),
      ),
    ).toBe(false);
  });
});
