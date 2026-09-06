import { join } from "node:path";
import {
  AGENT_TEST_STILL_MODEL,
  AGENT_TEST_STILL_MODEL_LABEL,
  AGENT_TEST_STILL_PATH,
  AGENT_TEST_STILL_PROMPT,
} from "./agentTestSpeech";

const screens = join(process.cwd(), "public/help/desktop/screens");

/** Same Grok still as Audio to Video — one character for the whole walkthrough. */
export const AGENT_TEST_GENERATE_PROMPT = AGENT_TEST_STILL_PROMPT;
export const AGENT_TEST_GENERATE_MODEL = AGENT_TEST_STILL_MODEL;
export const AGENT_TEST_GENERATE_MODEL_LABEL = AGENT_TEST_STILL_MODEL_LABEL;
export const AGENT_TEST_GENERATE_STILL_PATH = AGENT_TEST_STILL_PATH;
export const AGENT_TEST_EDITOR_GENERATE_PROMPT_SCREEN = join(
  screens,
  "editor-generate-prompt.png",
);
export const AGENT_TEST_EDITOR_GENERATE_RESULT_SCREEN = join(
  screens,
  "editor-generate-result.png",
);
