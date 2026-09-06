import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_TEST_STILL_MODEL,
  AGENT_TEST_STILL_MODEL_LABEL,
  AGENT_TEST_STILL_PATH,
  AGENT_TEST_STILL_PROMPT,
} from "./agentTestSpeech";
import {
  AGENT_TEST_EDITOR_GENERATE_PROMPT_SCREEN,
  AGENT_TEST_EDITOR_GENERATE_RESULT_SCREEN,
  AGENT_TEST_GENERATE_MODEL,
  AGENT_TEST_GENERATE_MODEL_LABEL,
  AGENT_TEST_GENERATE_PROMPT,
  AGENT_TEST_GENERATE_STILL_PATH,
} from "./agentTestGenerate";

describe("agent test generate fixture", () => {
  it("keeps generate on the shared Grok still and hands that project to Audio to Video", () => {
    const testSrc = readFileSync(
      join(process.cwd(), "integration/05-generation.integration.test.ts"),
      "utf8",
    );
    expect(testSrc).toContain("AGENT_TEST_GENERATE_PROMPT");
    expect(testSrc).toContain("AGENT_TEST_GENERATE_MODEL");
    expect(testSrc).toContain("panel: \"newAsset\"");
    expect(testSrc).toContain("captureHelpScreen");
    expect(testSrc).toContain("window.setSize");
    expect(testSrc).toContain("publishHelpStill");
    expect(testSrc).toContain("writeGenerateJourney");
    expect(testSrc).toContain("handedOff");
    expect(AGENT_TEST_GENERATE_MODEL).toBe(AGENT_TEST_STILL_MODEL);
    expect(AGENT_TEST_GENERATE_MODEL).toBe("xai/grok-imagine-image");
    expect(AGENT_TEST_GENERATE_MODEL_LABEL).toBe(AGENT_TEST_STILL_MODEL_LABEL);
    expect(AGENT_TEST_GENERATE_PROMPT).toBe(AGENT_TEST_STILL_PROMPT);
    expect(AGENT_TEST_GENERATE_STILL_PATH).toBe(AGENT_TEST_STILL_PATH);
    expect(AGENT_TEST_GENERATE_PROMPT.toLowerCase()).toContain("goblin");
    expect(AGENT_TEST_GENERATE_PROMPT.toLowerCase()).toContain("no headset");
    expect(AGENT_TEST_GENERATE_PROMPT.toLowerCase()).toContain("purple");

    const help = readFileSync(join(process.cwd(), "public/help/generate.html"), "utf8");
    expect(help).toContain(AGENT_TEST_GENERATE_PROMPT);
    expect(help).toContain(AGENT_TEST_GENERATE_MODEL_LABEL);
    expect(help).toContain("desktop/screens/editor-generate-prompt.png");
    expect(help).toContain("desktop/screens/editor-generate-result.png");
    expect(help).toContain("desktop/media/agent-test-still.png");
    expect(help).toContain("Where to go from here");
    expect(help).toContain("audio.html");
    expect(help).not.toMatch(/the (A2V |desktop )?test/i);
    expect(existsSync(AGENT_TEST_GENERATE_STILL_PATH)).toBe(true);
    expect(existsSync(AGENT_TEST_EDITOR_GENERATE_PROMPT_SCREEN)).toBe(true);
    expect(existsSync(AGENT_TEST_EDITOR_GENERATE_RESULT_SCREEN)).toBe(true);
    expect(statSync(AGENT_TEST_GENERATE_STILL_PATH).size).toBeGreaterThan(10_000);
  });
});
