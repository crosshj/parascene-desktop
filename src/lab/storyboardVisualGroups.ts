import type { VisualGroup } from "../project/types";

/** Timeline block fill — scenes sharing a group reuse the same base assets. */
export const VISUAL_GROUP_BLOCK_COLORS = [
  "rgba(96, 165, 250, 0.35)",
  "rgba(168, 85, 247, 0.35)",
  "rgba(34, 197, 94, 0.35)",
  "rgba(251, 191, 36, 0.35)",
  "rgba(244, 114, 182, 0.35)",
] as const;

/** Solid swatches for the legend key. */
export const VISUAL_GROUP_SWATCH_COLORS = [
  "rgba(96, 165, 250, 0.85)",
  "rgba(168, 85, 247, 0.85)",
  "rgba(34, 197, 94, 0.85)",
  "rgba(251, 191, 36, 0.85)",
  "rgba(244, 114, 182, 0.85)",
] as const;

/** Preview glow — same hue, softer. */
export const VISUAL_GROUP_GLOW_COLORS = [
  "rgba(96, 165, 250, 0.35)",
  "rgba(168, 85, 247, 0.35)",
  "rgba(34, 197, 94, 0.35)",
  "rgba(251, 191, 36, 0.35)",
  "rgba(244, 114, 182, 0.35)",
] as const;

export function visualGroupIndex(
  visualGroups: VisualGroup[],
  groupId: string,
): number {
  const index = visualGroups.findIndex((g) => g.id === groupId);
  return index >= 0 ? index % VISUAL_GROUP_BLOCK_COLORS.length : 0;
}

export function visualGroupBlockColor(
  visualGroups: VisualGroup[],
  groupId: string,
): string {
  return VISUAL_GROUP_BLOCK_COLORS[visualGroupIndex(visualGroups, groupId)];
}

export function visualGroupSwatchColor(index: number): string {
  return VISUAL_GROUP_SWATCH_COLORS[index % VISUAL_GROUP_SWATCH_COLORS.length];
}

export function visualGroupGlowColor(index: number): string {
  return VISUAL_GROUP_GLOW_COLORS[index % VISUAL_GROUP_GLOW_COLORS.length];
}
