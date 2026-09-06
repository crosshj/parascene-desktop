import { join } from "node:path";

const media = join(process.cwd(), "public/help/desktop/media");
const screens = join(process.cwd(), "public/help/desktop/screens");

/**
 * Directed read for the help/test speech. Keep this when regenerating TTS.
 * Spoken file is ~21s; A2V uses the first AGENT_TEST_A2V_DURATION_SEC seconds.
 */
export const AGENT_TEST_SPEECH_SCRIPT = [
  { direction: "excited", line: "Can you hear that?" },
  { direction: "laughing", line: "Every sound changes the picture." },
  {
    direction: "",
    line: "Now watch closely as the voice becomes movement, and the character begins to respond.",
  },
  { direction: "amazed", line: "Just like that, a still image becomes a scene." },
] as const;

/** Spoken lines only, no direction tags. */
export const AGENT_TEST_SPEECH_TEXT = AGENT_TEST_SPEECH_SCRIPT.map(
  (row) => row.line,
).join(" ");

export const AGENT_TEST_SPEECH_PATH = join(media, "agent-test-speech.wav");
export const AGENT_TEST_SPEECH_MP3_PATH = join(media, "agent-test-speech.mp3");
export const AGENT_TEST_VIDEO_PATH = join(media, "agent-test-speech.mp4");
export const AGENT_TEST_STILL_PATH = join(media, "agent-test-still.png");

/** Shared start still — Generate writes this; Audio to Video keeps using it. */
export const AGENT_TEST_STILL_MODEL = "xai/grok-imagine-image";
export const AGENT_TEST_STILL_MODEL_LABEL = "X.ai Grok Imagine Image";
export const AGENT_TEST_STILL_ASPECT = "16:9";
export const AGENT_TEST_STILL_PROMPT =
  "Friendly playful wiry purple goblin, approachable Pixar character, not sinister, not scary, not a villain. Waist-up portrait facing the camera. Huge expressive pointed ears that are completely bare — nothing on the ears, nothing behind the ears, no headset, no earpiece, no boom microphone, no earbuds. Warm yellow-green eyes, mobile eyebrows, a small closed mischievous smile, not a wide evil grin. Yellow round goggles pushed onto his bald forehead. Plain dark coat, bare cheeks, mouth completely unobstructed. Soft purple hands visible at the bottom of the frame, no claws. Plain dark gray studio backdrop, soft even lighting, clean silhouette, no text, no clutter, no extra props";

export const AGENT_TEST_A2V_MODEL = "ltx_a2v";
/** Full spoken file length. The timeline keeps this; video clips are shorter. */
export const AGENT_TEST_SPEECH_DURATION_SEC = 21;
/** First video clip length — LTX default. Users add more clips to fill the rest. */
export const AGENT_TEST_A2V_DURATION_SEC = 9;
export const AGENT_TEST_A2V_PROMPT =
  "The same friendly purple goblin speaks straight to camera. Playful, not sinister. Mouth, lips, and jaw clearly open and close in exact sync with the words, nothing covering the mouth, cheeks, or ears. Huge bare ears and yellow forehead goggles stay on — no headset, no earpiece, no microphone. Excited on the first line, a short laugh on the second, then he leans in and watches the viewer. Soft hands gesture near his chest. Head stays mostly still, eyes on camera. Plain dark gray backdrop, soft lighting, no text, no extra props";

export const AGENT_TEST_EDITOR_A2V_SCREEN = join(screens, "editor-a2v.png");
export const AGENT_TEST_EDITOR_A2V_FORM_SCREEN = join(
  screens,
  "editor-a2v-form.png",
);
export const AGENT_TEST_EDITOR_AUDIO_SCREEN = join(
  screens,
  "editor-audio-timeline.png",
);
