/**
 * Gemini Flash TTS prebuilt voices.
 * Ids stay exact for the API. Labels are display-only.
 */

export type GeminiSystemVoice = {
  voiceId: string;
  label: string;
};

/** Official prebuilt ids with gender + tone. Do not invent new ids. */
export const GEMINI_SYSTEM_VOICES: readonly GeminiSystemVoice[] = [
  { voiceId: "Achernar", label: "Achernar — Female; soft and understated" },
  { voiceId: "Achird", label: "Achird — Male; friendly and approachable" },
  { voiceId: "Algenib", label: "Algenib — Male; gravelly and textured" },
  { voiceId: "Algieba", label: "Algieba — Male; smooth and polished" },
  { voiceId: "Alnilam", label: "Alnilam — Male; firm and authoritative" },
  { voiceId: "Aoede", label: "Aoede — Female; breezy and relaxed" },
  { voiceId: "Autonoe", label: "Autonoe — Female; bright and energetic" },
  { voiceId: "Callirrhoe", label: "Callirrhoe — Female; easygoing and unforced" },
  { voiceId: "Charon", label: "Charon — Male; informative and composed" },
  { voiceId: "Despina", label: "Despina — Female; smooth and controlled" },
  { voiceId: "Enceladus", label: "Enceladus — Male; breathy and intimate" },
  { voiceId: "Erinome", label: "Erinome — Female; clear and articulate" },
  { voiceId: "Fenrir", label: "Fenrir — Male; excitable and energetic" },
  { voiceId: "Gacrux", label: "Gacrux — Mature female; grounded and experienced" },
  { voiceId: "Iapetus", label: "Iapetus — Male; clear and steady" },
  { voiceId: "Kore", label: "Kore — Female; firm and confident" },
  { voiceId: "Laomedeia", label: "Laomedeia — Female; upbeat and cheerful" },
  { voiceId: "Leda", label: "Leda — Young female; youthful and light" },
  { voiceId: "Orus", label: "Orus — Male; firm and direct" },
  { voiceId: "Pulcherrima", label: "Pulcherrima — Female; forward and assertive" },
  { voiceId: "Puck", label: "Puck — Male; upbeat and playful" },
  { voiceId: "Rasalgethi", label: "Rasalgethi — Male; informative and measured" },
  { voiceId: "Sadachbia", label: "Sadachbia — Male; lively and animated" },
  { voiceId: "Sadaltager", label: "Sadaltager — Male; knowledgeable and assured" },
  { voiceId: "Schedar", label: "Schedar — Male; even and balanced" },
  { voiceId: "Sulafat", label: "Sulafat — Female; warm and welcoming" },
  { voiceId: "Umbriel", label: "Umbriel — Male; easygoing and calm" },
  { voiceId: "Vindemiatrix", label: "Vindemiatrix — Female; gentle and tender" },
  { voiceId: "Zephyr", label: "Zephyr — Female; bright and airy" },
  {
    voiceId: "Zubenelgenubi",
    label: "Zubenelgenubi — Male; casual and conversational",
  },
];

const LABEL_BY_ID = new Map(
  GEMINI_SYSTEM_VOICES.map((voice) => [voice.voiceId.toLowerCase(), voice.label]),
);

export function geminiSystemVoiceLabel(voiceId: string): string {
  const id = voiceId.trim();
  return LABEL_BY_ID.get(id.toLowerCase()) ?? id;
}

export function isGeminiSystemVoiceId(voiceId: string): boolean {
  return LABEL_BY_ID.has(voiceId.trim().toLowerCase());
}
