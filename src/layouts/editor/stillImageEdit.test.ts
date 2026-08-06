import { describe, expect, it } from "vitest";
import type {
  ReplicateInputField,
  ReplicateModelDetail,
} from "../../replicate/replicateClient";
import {
  modelProducesImageOutput,
  pickImageInputField,
} from "./stillImageEdit";

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

describe("still image edit model inputs", () => {
  it("uses a scalar image URI", () => {
    const picked = pickImageInputField([
      field({ name: "prompt" }),
      field({ name: "input_image", fileLike: true, format: "uri" }),
    ]);
    expect(picked?.field.name).toBe("input_image");
    expect(picked?.array).toBe(false);
  });

  it("uses Nano Banana-style image_input arrays", () => {
    const picked = pickImageInputField([
      field({
        name: "image_input",
        typeName: "array",
        arrayItemFileLike: true,
      }),
    ]);
    expect(picked?.field.name).toBe("image_input");
    expect(picked?.array).toBe(true);
  });

  it("recognizes image arrays in stale cached schemas", () => {
    const picked = pickImageInputField([
      field({
        name: "reference_images",
        title: "Reference images",
        typeName: "array",
      }),
    ]);
    expect(picked?.field.name).toBe("reference_images");
    expect(picked?.array).toBe(true);
  });

  it("does not choose an image mask as the source", () => {
    const picked = pickImageInputField([
      field({ name: "mask", fileLike: true }),
      field({ name: "image", fileLike: true }),
    ]);
    expect(picked?.field.name).toBe("image");
  });

  it("does not send an image as flux-schnell's text prompt", () => {
    const picked = pickImageInputField([
      field({
        name: "prompt",
        typeName: "string",
        description: "Prompt for generated image",
      }),
      field({ name: "aspect_ratio", typeName: "string" }),
      field({ name: "output_format", typeName: "string" }),
    ]);

    expect(picked).toBeNull();
  });
});

function model(
  partial: Partial<ReplicateModelDetail> & { raw: unknown },
): Pick<ReplicateModelDetail, "raw" | "name" | "description" | "features"> {
  return {
    raw: partial.raw,
    name: partial.name ?? "test-model",
    description: partial.description ?? null,
    features: partial.features ?? [],
  };
}

describe("still image edit model outputs", () => {
  it("accepts an image from the default output example", () => {
    expect(
      modelProducesImageOutput(
        model({ raw: { default_example: { output: ["https://cdn.test/result.webp"] } } }),
      ),
    ).toBe(true);
  });

  it("rejects image-to-video models", () => {
    expect(
      modelProducesImageOutput(
        model({
          description: "Turn an image into a video",
          features: ["image_in", "video"],
          raw: {
            default_example: { output: "https://cdn.test/result.mp4" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects image analyzers with text output", () => {
    expect(
      modelProducesImageOutput(
        model({
          description: "Caption an image",
          features: ["image", "image_in", "text"],
          raw: {
            latest_version: {
              openapi_schema: {
                components: { schemas: { Output: { type: "string" } } },
              },
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("accepts an image-oriented URI output without an example", () => {
    expect(
      modelProducesImageOutput(
        model({
          description: "Edit and upscale an image",
          features: ["image", "image_in", "upscale"],
          raw: {
            latest_version: {
              openapi_schema: {
                components: {
                  schemas: {
                    Output: {
                      type: "array",
                      items: { type: "string", format: "uri" },
                    },
                  },
                },
              },
            },
          },
        }),
      ),
    ).toBe(true);
  });
});
