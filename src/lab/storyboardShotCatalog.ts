/** MV shot types — shared by OpenAI payloads and persisted scenes. */
export const STORYBOARD_SHOT_TYPES = [
  "lip_sync_cu",
  "lip_sync_mcu",
  "wide_performance",
  "instrument_detail",
  "metaphor_broll",
  "location_plate",
  "lyric_card",
  "crowd_energy",
  "push_in",
  "static_hold",
  "chorus_punch",
  "bridge_reset",
  "outro_hold",
] as const;

export type StoryboardShotType = (typeof STORYBOARD_SHOT_TYPES)[number];

export const STORYBOARD_SHOT_DESCRIPTIONS: Record<StoryboardShotType, string> = {
  lip_sync_cu: "Close-up lip-sync on performer face",
  lip_sync_mcu: "Medium close-up lip-sync, chest up",
  wide_performance: "Wide shot of performance space",
  instrument_detail: "Hands or instrument detail cutaway",
  metaphor_broll: "Symbolic visual metaphor b-roll",
  location_plate: "Establishing location / environment plate",
  lyric_card: "Static lyric typography card",
  crowd_energy: "Crowd or audience energy shot",
  push_in: "Slow camera push-in on subject",
  static_hold: "Locked-off static frame",
  chorus_punch: "High-energy chorus visual accent",
  bridge_reset: "Mood shift for bridge section",
  outro_hold: "Closing hold / fade visual",
};

export function shotCatalogForPayload(): Array<{
  id: StoryboardShotType;
  description: string;
}> {
  return STORYBOARD_SHOT_TYPES.map((id) => ({
    id,
    description: STORYBOARD_SHOT_DESCRIPTIONS[id],
  }));
}

export function isStoryboardShotType(value: unknown): value is StoryboardShotType {
  return (
    typeof value === "string" &&
    (STORYBOARD_SHOT_TYPES as readonly string[]).includes(value)
  );
}
