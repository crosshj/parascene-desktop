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

/** Curated English picker ids. Display names are labels only. */
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

/**
 * All 45 English system ids from the MiniMax FAQ.
 * Use Custom + the exact `voice_id` for ids that are not in the picker.
 */
export const MINIMAX_ENGLISH_FAQ_VOICES: readonly MiniMaxSystemVoice[] = [
  { voiceId: "English_expressive_narrator", label: "Expressive Narrator" },
  { voiceId: "English_radiant_girl", label: "Radiant Girl" },
  { voiceId: "English_magnetic_voiced_man", label: "Magnetic-voiced Male" },
  { voiceId: "English_compelling_lady1", label: "Compelling Lady" },
  { voiceId: "English_Aussie_Bloke", label: "Aussie Bloke" },
  { voiceId: "English_captivating_female1", label: "Captivating Female" },
  { voiceId: "English_Upbeat_Woman", label: "Upbeat Woman" },
  { voiceId: "English_Trustworth_Man", label: "Trustworthy Man" },
  { voiceId: "English_CalmWoman", label: "Calm Woman" },
  { voiceId: "English_UpsetGirl", label: "Upset Girl" },
  { voiceId: "English_Gentle-voiced_man", label: "Gentle-voiced Man" },
  { voiceId: "English_Whispering_girl", label: "Whispering girl" },
  { voiceId: "English_Diligent_Man", label: "Diligent Man" },
  { voiceId: "English_Graceful_Lady", label: "Graceful Lady" },
  { voiceId: "English_ReservedYoungMan", label: "Reserved Young Man" },
  { voiceId: "English_PlayfulGirl", label: "Playful Girl" },
  { voiceId: "English_ManWithDeepVoice", label: "Man With Deep Voice" },
  { voiceId: "English_MaturePartner", label: "Mature Partner" },
  { voiceId: "English_FriendlyPerson", label: "Friendly Guy" },
  { voiceId: "English_MatureBoss", label: "Bossy Lady" },
  { voiceId: "English_Debator", label: "Male Debater" },
  { voiceId: "English_LovelyGirl", label: "Lovely Girl" },
  { voiceId: "English_Steadymentor", label: "Reliable Man" },
  { voiceId: "English_Deep-VoicedGentleman", label: "Deep-voiced Gentleman" },
  { voiceId: "English_Wiselady", label: "Wise Lady" },
  { voiceId: "English_CaptivatingStoryteller", label: "Captivating Storyteller" },
  { voiceId: "English_DecentYoungMan", label: "Decent Young Man" },
  { voiceId: "English_SentimentalLady", label: "Sentimental Lady" },
  { voiceId: "English_ImposingManner", label: "Imposing Queen" },
  { voiceId: "English_SadTeen", label: "Teen Boy" },
  { voiceId: "English_PassionateWarrior", label: "Passionate Warrior" },
  { voiceId: "English_WiseScholar", label: "Wise Scholar" },
  { voiceId: "English_Soft-spokenGirl", label: "Soft-Spoken Girl" },
  { voiceId: "English_SereneWoman", label: "Serene Woman" },
  { voiceId: "English_ConfidentWoman", label: "Confident Woman" },
  { voiceId: "English_PatientMan", label: "Patient Man" },
  { voiceId: "English_Comedian", label: "Comedian" },
  { voiceId: "English_BossyLeader", label: "Bossy Leader" },
  { voiceId: "English_Strong-WilledBoy", label: "Strong-Willed Boy" },
  { voiceId: "English_StressedLady", label: "Stressed Lady" },
  { voiceId: "English_AssertiveQueen", label: "Assertive Queen" },
  { voiceId: "English_AnimeCharacter", label: "Female Narrator" },
  { voiceId: "English_Jovialman", label: "Jovial Man" },
  { voiceId: "English_WhimsicalGirl", label: "Whimsical Girl" },
  { voiceId: "English_Kind-heartedGirl", label: "Kind-Hearted Girl" },
];

export function isMiniMaxSystemVoiceId(voiceId: string): boolean {
  const id = voiceId.trim();
  return MINIMAX_SYSTEM_VOICES.some((voice) => voice.voiceId === id);
}

export function isMiniMaxEnglishFaqVoiceId(voiceId: string): boolean {
  const id = voiceId.trim();
  return MINIMAX_ENGLISH_FAQ_VOICES.some((voice) => voice.voiceId === id);
}

/** Official MiniMax speech-2.8 emotion enum. */
export const MINIMAX_SPEECH_EMOTION_VALUES = [
  "auto",
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "calm",
  "fluent",
  "neutral",
] as const;

export type MiniMaxSpeechEmotion = (typeof MINIMAX_SPEECH_EMOTION_VALUES)[number];

export const MINIMAX_SPEECH_EMOTIONS: ReadonlyArray<{
  value: MiniMaxSpeechEmotion;
  label: string;
}> = MINIMAX_SPEECH_EMOTION_VALUES.map((value) => ({
  value,
  label: `${value.charAt(0).toUpperCase()}${value.slice(1)}`,
}));

export function normalizeMinimaxEmotion(
  raw: string | null | undefined,
): MiniMaxSpeechEmotion | "" {
  const key = String(raw ?? "").trim().toLowerCase();
  return (MINIMAX_SPEECH_EMOTION_VALUES as readonly string[]).includes(key)
    ? (key as MiniMaxSpeechEmotion)
    : "";
}
