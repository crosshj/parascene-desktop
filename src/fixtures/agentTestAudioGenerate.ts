import { join } from "node:path";
import { RENDER_PROOF_GAP_SEC } from "../agent/renderAudioProof";

const screens = join(process.cwd(), "public/help/desktop/screens");
const media = join(process.cwd(), "public/help/desktop/media");

export const AGENT_TEST_AUDIO_PROJECT_PREFIX = "agent-test-audio-generate-";

export const AGENT_TEST_SPEECH_MODEL = "google/gemini-3.1-flash-tts";
export const AGENT_TEST_SPEAKER_VOICE = "Kore";
export const AGENT_TEST_SPEAKER_LINE = "The night market is still open.";

export const AGENT_TEST_RENDER_GAP_SEC = RENDER_PROOF_GAP_SEC;

export const AGENT_TEST_EDITOR_AUDIO_GENERATE_PROMPT_SCREEN = join(
  screens,
  "editor-generate-audio-prompt.png",
);
export const AGENT_TEST_EDITOR_AUDIO_GENERATE_RESULT_SCREEN = join(
  screens,
  "editor-generate-audio-result.png",
);
export const AGENT_TEST_EDITOR_AUDIO_GENERATE_TIMELINE_SCREEN = join(
  screens,
  "editor-generate-audio-timeline.png",
);

export const AGENT_TEST_FLASH_TTS_PATH = join(media, "generate-audio-kore.mp3");
