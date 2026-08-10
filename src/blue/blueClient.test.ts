import { describe, expect, it } from "vitest";
import {
  blueCapabilitiesToListPage,
  blueFieldsToInputFields,
  blueMethodThumbColor,
  blueMethodThumbColors,
  blueMethodToDetail,
  type BlueCapabilities,
} from "./blueClient";
import { defaultFormValue, resolveFormValue, buildRunInput } from "../layouts/lab/labSchemaForm";

describe("blueMethodThumbColor", () => {
  it("returns a stable pastel and distinct colors across the method list", () => {
    const names = [
      "audio2video",
      "image2image",
      "image2video",
      "reference2video",
      "text2image",
      "text2video",
      "video2video",
    ];
    expect(blueMethodThumbColor("text2image")).toBe(
      blueMethodThumbColor("text2image"),
    );
    const assigned = blueMethodThumbColors(names);
    expect(new Set(assigned.values()).size).toBe(names.length);
    // Assigned hues should not all sit in a narrow peach band.
    const warmish = [...assigned.values()].filter((c) =>
      ["#f07167", "#f4a261", "#e9c46a", "#e89a7a", "#ffa94d", "#ffb347"].includes(
        c,
      ),
    );
    expect(warmish.length).toBeLessThan(names.length - 1);
  });
});

describe("blueFieldsToInputFields", () => {
  it("maps select / text / number / boolean / media arrays", () => {
    const inputs = blueFieldsToInputFields({
      model: {
        label: "Model",
        type: "select",
        required: true,
        options: [
          { label: "Wan", value: "wan_i2v" },
          { label: "LTX", value: "ltx_i2v" },
        ],
      },
      prompt: { label: "Prompt", type: "text", required: true },
      duration_seconds: {
        label: "Duration",
        type: "number",
        min: 1,
        max: 15,
        default: 9,
      },
      prompt_magic: { type: "boolean", default: true, hidden: false },
      aspect_ratio: {
        type: "select",
        hidden: true,
        default: "1:1",
        options: [
          { label: "1:1", value: "1:1" },
          { label: "16:9", value: "16:9" },
        ],
      },
      input_images: { type: "image_url_array", required: true },
      secret: { type: "text", hidden: true },
    });
    expect(inputs.map((f) => f.name)).toEqual([
      "model",
      "prompt",
      "duration_seconds",
      "prompt_magic",
      "aspect_ratio",
      "input_images",
      "secret",
    ]);
    const model = inputs.find((f) => f.name === "model")!;
    expect(model.enumValues).toEqual(["wan_i2v", "ltx_i2v"]);
    expect(model.defaultValue).toBeUndefined();
    const images = inputs.find((f) => f.name === "input_images")!;
    expect(images.arrayItemFileLike).toBe(true);
    expect(images.typeName).toBe("array");
    const dur = inputs.find((f) => f.name === "duration_seconds")!;
    expect(dur.minimum).toBe(1);
    expect(dur.maximum).toBe(15);
    expect(dur.defaultValue).toBe(9);
    const magic = inputs.find((f) => f.name === "prompt_magic")!;
    expect(magic.defaultValue).toBe(true);
    const aspect = inputs.find((f) => f.name === "aspect_ratio")!;
    expect(aspect.defaultValue).toBe("1:1");
    expect(aspect.enumValues).toEqual(["1:1", "16:9"]);
  });

  it("defaultFormValue applies schema defaults and required enum fallback", () => {
    const inputs = blueFieldsToInputFields({
      model: {
        type: "select",
        required: true,
        options: [{ value: "wan_i2v" }, { value: "ltx_i2v" }],
      },
      prompt_magic: { type: "boolean", default: true },
      aspect_ratio: {
        type: "select",
        default: "1:1",
        options: [{ value: "1:1" }, { value: "16:9" }],
      },
      start_offset_seconds: { type: "number", default: 0 },
      optional_model: {
        type: "select",
        required: false,
        options: [{ value: "a" }, { value: "b" }],
      },
    });
    const byName = Object.fromEntries(inputs.map((f) => [f.name, f]));
    expect(defaultFormValue(byName.model)).toBe("wan_i2v");
    expect(defaultFormValue(byName.prompt_magic)).toBe("true");
    expect(defaultFormValue(byName.aspect_ratio)).toBe("1:1");
    expect(defaultFormValue(byName.start_offset_seconds)).toBe("0");
    expect(defaultFormValue(byName.optional_model)).toBe("");
  });

  it("infers denoise / duration defaults from Blue prose when schema omits default", () => {
    const inputs = blueFieldsToInputFields({
      denoise: {
        type: "number",
        min: 0,
        max: 1,
        description:
          "Strength of denoising. If not provided, SDXL models default to 0.65.",
      },
      duration_seconds: {
        type: "number",
        min: 1,
        max: 15,
        description:
          "Output video length in seconds (default 9). Audio is trimmed to match.",
      },
      duration_range: {
        type: "number",
        min: 1,
        max: 15,
        description:
          "Output video length in seconds (default ~5–9 depending on model).",
      },
      seed: {
        type: "number",
        min: 0,
        description:
          "Optional deterministic seed. If not provided, a random seed is used.",
      },
    });
    const byName = Object.fromEntries(inputs.map((f) => [f.name, f]));
    expect(byName.denoise.defaultValue).toBe(0.65);
    expect(defaultFormValue(byName.denoise)).toBe("0.65");
    expect(byName.duration_seconds.defaultValue).toBe(9);
    expect(defaultFormValue(byName.duration_seconds)).toBe("9");
    expect(byName.duration_range.defaultValue).toBe(9);
    expect(byName.seed.defaultValue).toBeUndefined();
    expect(defaultFormValue(byName.seed)).toBe("");
  });

  it("resolveFormValue / buildRunInput treat blank required select as first option", () => {
    const inputs = blueFieldsToInputFields({
      model: {
        type: "select",
        required: true,
        options: [
          { value: "diffusion_models/flux/flux1-dev.safetensors" },
          { value: "other" },
        ],
      },
      prompt: { type: "text", required: true },
    });
    const model = inputs.find((f) => f.name === "model")!;
    expect(resolveFormValue(model, {})).toBe(
      "diffusion_models/flux/flux1-dev.safetensors",
    );
    expect(resolveFormValue(model, { model: "" })).toBe(
      "diffusion_models/flux/flux1-dev.safetensors",
    );
    expect(
      buildRunInput(inputs, { model: "", prompt: "silly dog" }),
    ).toEqual({
      model: "diffusion_models/flux/flux1-dev.safetensors",
      prompt: "silly dog",
    });
  });
});

describe("blueCapabilitiesToListPage / blueMethodToDetail", () => {
  const caps: BlueCapabilities = {
    methods: {
      image2video: {
        id: "image2video",
        name: "Image To Video",
        description: "i2v",
        intent: "video_generate",
        async: true,
        fields: {
          model: {
            type: "select",
            options: [{ value: "wan_i2v" }],
          },
          prompt: { type: "text", required: true },
        },
      },
      text2image: {
        id: "text2image",
        name: "Text To Image",
        fields: { prompt: { type: "text" } },
      },
    },
    capability_matrix: [
      {
        method: "image2video",
        model: "wan_i2v",
        capabilities: ["i2v", "flf"],
      },
    ],
  };

  it("lists methods as blue/* rows", () => {
    const page = blueCapabilitiesToListPage(caps);
    expect(page.rows.map((r) => r.name)).toEqual([
      "text2image",
      "image2video",
    ]);
    expect(page.rows.every((r) => r.owner === "blue" && r.enabled)).toBe(true);
  });

  it("orders image outputs before video", () => {
    const page = blueCapabilitiesToListPage({
      methods: {
        audio2video: {
          id: "audio2video",
          intent: "video_generate",
          name: "Audio To Video",
        },
        text2image: {
          id: "text2image",
          intent: "image_generate",
          name: "Text To Image",
        },
        image2image: {
          id: "image2image",
          intent: "image_mutate",
          name: "Image To Image",
        },
        text2video: {
          id: "text2video",
          intent: "video_generate",
          name: "Text To Video",
        },
      },
    });
    expect(page.rows.map((r) => r.name)).toEqual([
      "text2image",
      "image2image",
      "text2video",
      "audio2video",
    ]);
  });

  it("secondary-sorts by source before 2 within output group", () => {
    const page = blueCapabilitiesToListPage({
      methods: {
        video2video: { id: "video2video", intent: "video_generate" },
        reference2video: { id: "reference2video", intent: "video_generate" },
        audio2video: { id: "audio2video", intent: "video_generate" },
        image2video: { id: "image2video", intent: "video_generate" },
        text2video: { id: "text2video", intent: "video_generate" },
        image2image: { id: "image2image", intent: "image_mutate" },
        text2image: { id: "text2image", intent: "image_generate" },
      },
    });
    expect(page.rows.map((r) => r.name)).toEqual([
      "text2image",
      "image2image",
      "text2video",
      "image2video",
      "audio2video",
      "reference2video",
      "video2video",
    ]);
  });

  it("filters by query", () => {
    const page = blueCapabilitiesToListPage(caps, "image2video");
    expect(page.rows.map((r) => r.name)).toEqual(["image2video"]);
  });

  it("builds detail with mapped inputs + matrix features", () => {
    const detail = blueMethodToDetail(
      "image2video",
      caps.methods!.image2video,
      caps.capability_matrix,
    );
    expect(detail.owner).toBe("blue");
    expect(detail.schemaCached).toBe(true);
    expect(detail.inputs.some((f) => f.name === "prompt")).toBe(true);
    expect(detail.features).toEqual(
      expect.arrayContaining(["video_generate", "async", "i2v", "flf"]),
    );
  });
});
