/** Project aspect ratios — same creative presets as Library aspect filters. */

export const PROJECT_ASPECT_OPTIONS = [
  { id: "1:1", label: "1:1", sublabel: "square", w: 1, h: 1 },
  { id: "9:16", label: "9:16", sublabel: "phone", w: 9, h: 16 },
  { id: "4:5", label: "4:5", sublabel: "portrait", w: 4, h: 5 },
  { id: "16:9", label: "16:9", sublabel: "cinema", w: 16, h: 9 },
] as const;

export type ProjectAspectRatio = (typeof PROJECT_ASPECT_OPTIONS)[number]["id"];

export const DEFAULT_PROJECT_ASPECT_RATIO: ProjectAspectRatio = "16:9";

const IDS = new Set<string>(PROJECT_ASPECT_OPTIONS.map((o) => o.id));

export function isProjectAspectRatio(value: unknown): value is ProjectAspectRatio {
  return typeof value === "string" && IDS.has(value);
}

export function projectAspectCss(ratio: ProjectAspectRatio): string {
  const opt = PROJECT_ASPECT_OPTIONS.find((o) => o.id === ratio);
  const { w, h } = opt ?? PROJECT_ASPECT_OPTIONS[3];
  return `${w} / ${h}`;
}
