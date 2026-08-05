import { describe, expect, it } from "vitest";
import type { ReplicateInputField } from "../../replicate/replicateClient";
import { pickImageInputField } from "./stillImageEdit";

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
});
