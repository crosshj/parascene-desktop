import { join } from "node:path";

const screens = join(process.cwd(), "public/help/desktop/screens");
const media = join(process.cwd(), "public/help/desktop/media");

export const AGENT_TEST_AUDIO_PROJECT_PREFIX = "agent-test-audio-generate-";

export const AGENT_TEST_SPEECH_MODEL = "google/gemini-3.1-flash-tts";
export const AGENT_TEST_MUSIC_MODEL = "google/lyria-3";

export const AGENT_TEST_SPEAKER_ONE_VOICE = "Kore";
export const AGENT_TEST_SPEAKER_TWO_VOICE = "Puck";

export const AGENT_TEST_SPEAKER_ONE_LINE = "The night market is still open.";
export const AGENT_TEST_SPEAKER_TWO_LINE = "Then we should walk down together.";
export const AGENT_TEST_MUSIC_PROMPT =
  "Warm night market, soft strings under lantern light, no vocals";

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

export const AGENT_TEST_SPEAKER_ONE_PATH = join(media, "generate-audio-kore.mp3");
export const AGENT_TEST_SPEAKER_TWO_PATH = join(media, "generate-audio-puck.mp3");
export const AGENT_TEST_MUSIC_PATH = join(media, "generate-audio-lyria.mp3");
