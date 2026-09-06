import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TEST_STILL_PATH, AGENT_TEST_STILL_PROMPT } from "./agentTestSpeech";
import {
  AGENT_TEST_IMAGE_MODELS_PROMPT,
  agentTestImageModels,
  imageEditModels,
  imageModelGenerateTweak,
  imageModelLineage,
  imageModelStillPath,
  imageModelStillRel,
  imageModelsByLineage,
  isInputImageEditModel,
  isSharedGrokStill,
  writeImageModelsHelpPage,
} from "./agentTestImageModels";

describe("agent test image models fixture", () => {
  it("covers every Parascene Text to Image model and writes the Help page", () => {
    const models = agentTestImageModels();
    expect(models.length).toBeGreaterThan(10);
    expect(models.some(isSharedGrokStill)).toBe(true);
    expect(AGENT_TEST_IMAGE_MODELS_PROMPT).toBe(AGENT_TEST_STILL_PROMPT);
    expect(imageModelsByLineage().length).toBeGreaterThan(3);
    for (const model of models) {
      expect(imageModelLineage(model).title.length).toBeGreaterThan(3);
    }
    const zImage = models.filter((model) => /z[-_]image/i.test(`${model.label} ${model.value}`));
    expect(zImage.length).toBeGreaterThan(0);
    expect(zImage.every((model) => imageModelLineage(model).id === "zimage")).toBe(true);
    const pony = models.filter((model) => /pony/i.test(`${model.label} ${model.value}`));
    expect(pony.length).toBeGreaterThan(0);
    expect(pony.every((model) => imageModelLineage(model).id === "sdxl")).toBe(true);

    const dest = writeImageModelsHelpPage();
    const help = readFileSync(dest, "utf8");
    expect(help).toContain("<h1>Image models</h1>");
    expect(help).toContain(AGENT_TEST_IMAGE_MODELS_PROMPT);
    expect(help).toContain("Where to go from here");
    expect(help).toContain("generate.html");
    expect(help).not.toMatch(/the (A2V |desktop )?test/i);
    expect(help).toContain("<h2>Z-Image</h2>");
    expect(help).toContain("<h2>Image edit</h2>");
    expect(help.indexOf("<h2>Z-Image</h2>")).toBeLessThan(help.indexOf("<h2>Frontier stills</h2>"));
    expect(imageEditModels().length).toBeGreaterThan(3);
    expect(
      imageEditModels().some((model) => /qwen_image_edit/i.test(model.value)),
    ).toBe(true);
    expect(imageEditModels().some((model) => /kontext/i.test(model.value))).toBe(true);
    for (const model of models) {
      if (isInputImageEditModel(model)) {
        expect(help).toContain(model.label);
        expect(help).not.toContain(`src="${imageModelStillRel(model)}"`);
        expect(existsSync(imageModelStillPath(model))).toBe(false);
        continue;
      }
      if (existsSync(imageModelStillPath(model))) {
        expect(help).toContain(model.label);
        expect(help).toContain(`src="${imageModelStillRel(model)}"`);
      } else {
        expect(help).not.toContain(`src="${imageModelStillRel(model)}"`);
      }
    }
    expect(imageModelGenerateTweak({ value: "recraft-ai/recraft-v4" } as never)?.size).toBe(
      "1344x768",
    );
    expect(existsSync(AGENT_TEST_STILL_PATH)).toBe(true);
    expect(existsSync(imageModelStillPath(models.find(isSharedGrokStill)!))).toBe(
      true,
    );

    const testSrc = readFileSync(
      join(process.cwd(), "integration/07-image-models.integration.test.ts"),
      "utf8",
    );
    expect(testSrc).toContain("agentTestImageModels");
    expect(testSrc).toContain("generation.start");
    expect(testSrc).toContain("writeImageModelsHelpPage");
    expect(testSrc).toContain("isSharedGrokStill");
    expect(testSrc).toContain("isInputImageEditModel");
  });
});
