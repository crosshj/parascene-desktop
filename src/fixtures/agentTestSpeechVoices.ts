import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { geminiSystemVoiceLabel } from "../layouts/editor/geminiSystemVoices";
import {
  isMiniMaxSystemVoiceId,
  MINIMAX_ENGLISH_FAQ_VOICES,
  MINIMAX_SYSTEM_VOICE_FAQ_URL,
} from "../layouts/editor/minimaxSystemVoices";

const HELP_ROOT = join(process.cwd(), "public/help");
const MEDIA_VOICES = join(HELP_ROOT, "desktop/media/voices");
const SCREENS = join(HELP_ROOT, "desktop/screens");

export const AGENT_TEST_SPEECH_VOICES_PROJECT_PREFIX = "agent-test-speech-voices-";

export const AGENT_TEST_MINIMAX_SPEECH_MODEL = "minimax/speech-2.8-turbo";
export const AGENT_TEST_GEMINI_SPEECH_MODEL = "google/gemini-3.1-flash-tts";

export const AGENT_TEST_SPEECH_VOICES_LINE = "Hello. This is how I sound.";
export const AGENT_TEST_SPEECH_VOICES_PAUSE = "Wait for it. <#1.0#> There.";
export const AGENT_TEST_SPEECH_VOICES_INLINE = "{happy}The results are in.{/happy}";
export const AGENT_TEST_SPEECH_VOICES_LAUGHS =
  "That's wonderful (laughs) and we did it.";
export const AGENT_TEST_SPEECH_VOICES_STYLE =
  "Whispered, close to the microphone.";
export const AGENT_TEST_SPEECH_VOICES_CUSTOM_ID = "English_Whispering_girl";
export const AGENT_TEST_SPEECH_VOICES_PICKER_ID = "English_expressive_narrator";
export const AGENT_TEST_SPEECH_VOICES_GEMINI_ID = "Kore";

export const AGENT_TEST_SPEECH_VOICES_CUSTOM_SCREEN = join(
  SCREENS,
  "editor-speech-voices-custom.png",
);
export const AGENT_TEST_SPEECH_VOICES_MARKUP_SCREEN = join(
  SCREENS,
  "editor-speech-voices-markup.png",
);
export const AGENT_TEST_SPEECH_VOICES_GEMINI_STYLE_SCREEN = join(
  SCREENS,
  "editor-speech-voices-gemini-style.png",
);

export const AGENT_TEST_GEMINI_MAJOR_VOICES = [
  "Kore",
  "Puck",
  "Charon",
  "Zephyr",
  "Fenrir",
  "Leda",
] as const;

export type SpeechVoiceSource = "picker" | "custom" | "named" | "markup";
export type SpeechVoiceSection = "minimax" | "gemini" | "delivery";

export type SpeechVoiceClip = {
  id: string;
  section: SpeechVoiceSection;
  source: SpeechVoiceSource;
  model: string;
  voice: string;
  prompt: string;
  emotion?: string;
  style?: string;
  label: string;
  file: string;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function speechVoiceDest(clip: SpeechVoiceClip): string {
  return join(MEDIA_VOICES, clip.file);
}

export function speechVoiceRel(clip: SpeechVoiceClip): string {
  return `desktop/media/voices/${clip.file}`;
}

export function speechVoicePromptContains(): string[] {
  return [
    AGENT_TEST_SPEECH_VOICES_LINE,
    AGENT_TEST_SPEECH_VOICES_PAUSE,
    AGENT_TEST_SPEECH_VOICES_INLINE,
    AGENT_TEST_SPEECH_VOICES_LAUGHS,
  ];
}

export function speechVoiceClips(): SpeechVoiceClip[] {
  const minimax = MINIMAX_ENGLISH_FAQ_VOICES.map((voice) => {
    const picker = isMiniMaxSystemVoiceId(voice.voiceId);
    return {
      id: `minimax-${slugify(voice.voiceId)}`,
      section: "minimax" as const,
      source: picker ? ("picker" as const) : ("custom" as const),
      model: AGENT_TEST_MINIMAX_SPEECH_MODEL,
      voice: voice.voiceId,
      prompt: AGENT_TEST_SPEECH_VOICES_LINE,
      label: voice.label,
      file: `minimax-${slugify(voice.voiceId)}.mp3`,
    };
  });

  const gemini = AGENT_TEST_GEMINI_MAJOR_VOICES.map((voice) => ({
    id: `gemini-${slugify(voice)}`,
    section: "gemini" as const,
    source: "named" as const,
    model: AGENT_TEST_GEMINI_SPEECH_MODEL,
    voice,
    prompt: AGENT_TEST_SPEECH_VOICES_LINE,
    label: geminiSystemVoiceLabel(voice),
    file: `gemini-${slugify(voice)}.mp3`,
  }));

  const delivery: SpeechVoiceClip[] = [
    {
      id: "minimax-pause",
      section: "delivery",
      source: "markup",
      model: AGENT_TEST_MINIMAX_SPEECH_MODEL,
      voice: AGENT_TEST_SPEECH_VOICES_PICKER_ID,
      prompt: AGENT_TEST_SPEECH_VOICES_PAUSE,
      label: "MiniMax pause",
      file: "minimax-pause.mp3",
    },
    {
      id: "gemini-pause-markup",
      section: "delivery",
      source: "markup",
      model: AGENT_TEST_GEMINI_SPEECH_MODEL,
      voice: AGENT_TEST_SPEECH_VOICES_GEMINI_ID,
      prompt: AGENT_TEST_SPEECH_VOICES_PAUSE,
      label: "Gemini reads the marks",
      file: "gemini-pause-markup.mp3",
    },
    {
      id: "minimax-laughs",
      section: "delivery",
      source: "markup",
      model: AGENT_TEST_MINIMAX_SPEECH_MODEL,
      voice: AGENT_TEST_SPEECH_VOICES_PICKER_ID,
      prompt: AGENT_TEST_SPEECH_VOICES_LAUGHS,
      label: "MiniMax laugh",
      file: "minimax-laughs.mp3",
    },
    {
      id: "minimax-emotion-happy",
      section: "delivery",
      source: "markup",
      model: AGENT_TEST_MINIMAX_SPEECH_MODEL,
      voice: AGENT_TEST_SPEECH_VOICES_PICKER_ID,
      prompt: AGENT_TEST_SPEECH_VOICES_LINE,
      emotion: "happy",
      label: "MiniMax Emotion · Happy",
      file: "minimax-emotion-happy.mp3",
    },
    {
      id: "minimax-emotion-sad",
      section: "delivery",
      source: "markup",
      model: AGENT_TEST_MINIMAX_SPEECH_MODEL,
      voice: AGENT_TEST_SPEECH_VOICES_PICKER_ID,
      prompt: AGENT_TEST_SPEECH_VOICES_LINE,
      emotion: "sad",
      label: "MiniMax Emotion · Sad",
      file: "minimax-emotion-sad.mp3",
    },
    {
      id: "gemini-style-whisper",
      section: "delivery",
      source: "markup",
      model: AGENT_TEST_GEMINI_SPEECH_MODEL,
      voice: AGENT_TEST_SPEECH_VOICES_GEMINI_ID,
      prompt: AGENT_TEST_SPEECH_VOICES_LINE,
      style: AGENT_TEST_SPEECH_VOICES_STYLE,
      label: "Gemini Style · whispered",
      file: "gemini-style-whisper.mp3",
    },
  ];

  return [...minimax, ...gemini, ...delivery];
}

export function speechVoiceInvokeArgs(
  clip: SpeechVoiceClip,
  projectId: string,
  generate?: boolean,
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    projectId,
    intent: "text_to_speech",
    prompt: clip.prompt,
    model: clip.model,
    voice: clip.voice,
  };
  if (clip.emotion) args.emotion = clip.emotion;
  if (clip.style) args.style = clip.style;
  if (generate === false) args.generate = false;
  return args;
}

function clipById(id: string): SpeechVoiceClip {
  const clip = speechVoiceClips().find((row) => row.id === id);
  if (!clip) throw new Error(`Missing speech voice clip ${id}`);
  return clip;
}

function voiceCard(clip: SpeechVoiceClip, caption?: string): string {
  const badge =
    clip.source === "custom"
      ? '<span class="voice-badge">Custom</span>'
      : clip.source === "picker"
        ? '<span class="voice-badge">In the list</span>'
        : "";
  return `      <figure class="voice-card">
        <audio controls preload="none" src="${speechVoiceRel(clip)}"></audio>
        <figcaption>${escapeHtml(caption ?? clip.label)}${badge}<code class="voice-id">${escapeHtml(clip.voice)}</code></figcaption>
      </figure>`;
}

function voiceGrid(clips: SpeechVoiceClip[]): string {
  return `      <div class="voice-grid">
${clips.map((clip) => voiceCard(clip)).join("\n")}
      </div>`;
}

const HOME_ICON = `        <svg class="home-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
          <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>`;

/** Writes the Topics listening page. Call after clips are published. */
export function writeSpeechVoicesHelpPage(): string {
  mkdirSync(MEDIA_VOICES, { recursive: true });
  const clips = speechVoiceClips();
  const minimaxPicker = clips.filter((clip) => clip.source === "picker");
  const minimaxCustom = clips.filter((clip) => clip.source === "custom");
  const gemini = clips.filter((clip) => clip.section === "gemini");
  const narrator = clipById("minimax-english-expressive-narrator");
  const kore = clipById("gemini-kore");
  const whisper = clipById("minimax-english-whispering-girl");
  const pause = clipById("minimax-pause");
  const geminiPause = clipById("gemini-pause-markup");
  const laughs = clipById("minimax-laughs");
  const emotionHappy = clipById("minimax-emotion-happy");
  const emotionSad = clipById("minimax-emotion-sad");
  const geminiStyle = clipById("gemini-style-whisper");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Speech voices — Parascene Help</title>
    <link rel="stylesheet" href="help.css" />
  </head>
  <body>
    <header class="help-top">
      <a class="back" href="index.html">
${HOME_ICON}
        All topics
      </a>
    </header>
    <main>
      <h1>Speech voices</h1>
      <p>
        Same line, two models. MiniMax has English system ids you pick, or
        paste. Gemini has named voices and a Style box. The marks in the line
        only work on MiniMax.
      </p>

      <h2>The same line</h2>
      <p>We typed this on both models.</p>
      <pre><code>${escapeHtml(AGENT_TEST_SPEECH_VOICES_LINE)}</code></pre>
      <div class="voice-grid voice-grid--compare">
${voiceCard(kore, "Gemini · Kore")}
${voiceCard(narrator, "MiniMax · Expressive Narrator")}
      </div>

      <h2>Custom voice ids</h2>
      <p>
        MiniMax Voice is a short list. Everything else uses
        <strong>Custom</strong>. Pick Custom, then paste the exact
        <code>voice_id</code>. The name on
        <a href="${MINIMAX_SYSTEM_VOICE_FAQ_URL}" target="_blank" rel="noopener noreferrer">MiniMax’s system voice list</a>
        is only a label — the id is what the model wants. English has 45
        system ids. A cloned id from <strong>Train voice</strong> works the
        same way.
      </p>
      <ol class="steps">
        <li>Add asset → <strong>Text to Speech</strong> → Parascene.</li>
        <li>Model <code>MiniMax Speech 2.8 Turbo</code>.</li>
        <li>Voice <strong>Custom</strong>.</li>
        <li>
          Voice ID
          <code>${escapeHtml(AGENT_TEST_SPEECH_VOICES_CUSTOM_ID)}</code>.
        </li>
      </ol>
      <figure>
        <img
          src="desktop/screens/editor-speech-voices-custom.png"
          alt="New asset panel with MiniMax Speech, Custom selected, and a system voice id pasted in"
        />
        <figcaption>
          Custom selected. The id is from the MiniMax list — it is not in the
          Voice dropdown.
        </figcaption>
      </figure>
${voiceCard(whisper, "Whispering girl — pasted as Custom")}

      <h2>Pauses, emotion, and sounds</h2>
      <p>
        MiniMax reads marks in the line. Gemini does not — it will speak the
        marks as words. Gemini steering is the <strong>Style</strong> box.
      </p>

      <h3>MiniMax pause</h3>
      <p>
        <code>&lt;#seconds#&gt;</code> inserts silence. Put a word between two
        pauses.
      </p>
      <pre><code>${escapeHtml(AGENT_TEST_SPEECH_VOICES_PAUSE)}</code></pre>
      <figure>
        <img
          src="desktop/screens/editor-speech-voices-markup.png"
          alt="MiniMax speech form with a pause mark in the line and Emotion set"
        />
        <figcaption>
          The pause sits in the line. Emotion is a separate control.
        </figcaption>
      </figure>
      <div class="voice-grid voice-grid--compare">
${voiceCard(pause, "MiniMax hears a beat")}
${voiceCard(geminiPause, "Gemini says the marks")}
      </div>

      <h3>MiniMax emotion</h3>
      <p>
        <strong>Emotion</strong> is a control, not marks in the line. Happy,
        sad, angry, fearful, disgusted, surprised, calm, fluent, or auto.
        Braces like <code>{happy}</code> are spoken.
      </p>
      <div class="voice-grid">
${voiceCard(emotionHappy)}
${voiceCard(emotionSad)}
      </div>

      <h3>MiniMax sounds</h3>
      <p>
        Parentheses add a breath or a laugh in place:
        <code>(laughs)</code>, <code>(sighs)</code>, <code>(breath)</code>.
      </p>
      <pre><code>${escapeHtml(AGENT_TEST_SPEECH_VOICES_LAUGHS)}</code></pre>
${voiceCard(laughs)}

      <h3>Gemini Style</h3>
      <p>
        Gemini has no pause marks and no emotion menu. Type how it should
        speak in <strong>Style</strong>.
      </p>
      <pre><code>${escapeHtml(AGENT_TEST_SPEECH_VOICES_STYLE)}</code></pre>
      <figure>
        <img
          src="desktop/screens/editor-speech-voices-gemini-style.png"
          alt="Gemini Flash TTS form with Kore and a whispered style"
        />
        <figcaption>Kore, with Style filled in.</figcaption>
      </figure>
${voiceCard(geminiStyle)}

      <h2>MiniMax English voices</h2>
      <p>
        Same line on every English system id. <strong>In the list</strong> is
        a Voice dropdown choice. <strong>Custom</strong> is the same id pasted
        after you pick Custom.
      </p>
      <h3>In the Voice list</h3>
${voiceGrid(minimaxPicker)}
      <h3>Pasted as Custom</h3>
${voiceGrid(minimaxCustom)}

      <h2>Gemini voices</h2>
      <p>
        Named voices on Flash TTS. The list in the form is longer — these are
        a few that sit far apart.
      </p>
${voiceGrid(gemini)}

      <h2>Where to go from here</h2>
      <p class="more">
        <a href="generate-audio.html">Generate speech and music</a> — one
        spoken line, then a second clip on A2.
      </p>
      <p class="more">
        <a href="audio-models.html">Audio models</a> — speech and music, by
        job.
      </p>
      <p class="more">
        <a href="audio.html">Generate a video with audio</a> — turn a spoken
        file into a talking clip.
      </p>
    </main>
    <script src="help.js"></script>
  </body>
</html>
`;
  const dest = join(HELP_ROOT, "speech-voices.html");
  writeFileSync(dest, html);
  return dest;
}
