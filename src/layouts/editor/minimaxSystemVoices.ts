/**
 * MiniMax system voice ids.
 * Source of truth: https://platform.minimax.io/docs/faq/system-voice-id
 * Display names are labels only — the API wants the exact `voice_id`.
 */

export const MINIMAX_SYSTEM_VOICE_FAQ_URL =
  "https://platform.minimax.io/docs/faq/system-voice-id";

export type MiniMaxSystemVoice = {
  voiceId: string;
  label: string;
};

/** Official English system ids from the MiniMax FAQ — do not invent new ids. */
export const MINIMAX_SYSTEM_VOICES: readonly MiniMaxSystemVoice[] = [
  { voiceId: "English_expressive_narrator", label: "Expressive narrator" },
  { voiceId: "English_radiant_girl", label: "Radiant girl" },
  { voiceId: "English_magnetic_voiced_man", label: "Magnetic man" },
  { voiceId: "English_compelling_lady1", label: "Compelling lady" },
  { voiceId: "English_Aussie_Bloke", label: "Aussie bloke" },
  { voiceId: "English_captivating_female1", label: "Captivating female" },
  { voiceId: "English_Upbeat_Woman", label: "Upbeat woman" },
  { voiceId: "English_Trustworth_Man", label: "Trustworthy man" },
  { voiceId: "English_CalmWoman", label: "Calm woman" },
  { voiceId: "English_ReservedYoungMan", label: "Reserved young man" },
  { voiceId: "English_PlayfulGirl", label: "Playful girl" },
  { voiceId: "English_ManWithDeepVoice", label: "Deep-voiced man" },
  { voiceId: "English_Graceful_Lady", label: "Graceful lady" },
  { voiceId: "English_CasualMan", label: "Casual man" },
];

export function isMiniMaxSystemVoiceId(voiceId: string): boolean {
  const id = voiceId.trim();
  return MINIMAX_SYSTEM_VOICES.some((voice) => voice.voiceId === id);
}
