/** Project aspect ratios — same creative presets as Library aspect filters. */

export const PROJECT_ASPECT_OPTIONS = [
  { id: "1:1", label: "1:1", sublabel: "square", w: 1, h: 1 },
  { id: "9:16", label: "9:16", sublabel: "phone", w: 9, h: 16 },
  { id: "4:5", label: "4:5", sublabel: "portrait", w: 4, h: 5 },
  { id: "16:9", label: "16:9", sublabel: "cinema", w: 16, h: 9 },
] as const;

export type ProjectAspectOption = (typeof PROJECT_ASPECT_OPTIONS)[number];
export type ProjectAspectRatio = ProjectAspectOption["id"];

export const DEFAULT_PROJECT_ASPECT_RATIO: ProjectAspectRatio = "16:9";

/** Mini chooser left→right order (glyph row). */
const ASPECT_CHOOSER_ORDER: readonly ProjectAspectRatio[] = [
  "1:1",
  "4:5",
  "9:16",
  "16:9",
];

const IDS = new Set<string>(PROJECT_ASPECT_OPTIONS.map((o) => o.id));
const BY_ID = new Map(
  PROJECT_ASPECT_OPTIONS.map((opt) => [opt.id, opt] as const),
);

export function isProjectAspectRatio(value: unknown): value is ProjectAspectRatio {
  return typeof value === "string" && IDS.has(value);
}

export function projectAspectCss(ratio: ProjectAspectRatio): string {
  const opt = BY_ID.get(ratio) ?? BY_ID.get(DEFAULT_PROJECT_ASPECT_RATIO)!;
  return `${opt.w} / ${opt.h}`;
}

/**
 * Known creative ratios the model enum supports — never invents extras, never
 * surfaces unsupported schema values (e.g. 21:9).
 */
export function aspectChooserOptionsFromSupported(
  supported: Iterable<string> | null | undefined,
): ProjectAspectOption[] {
  if (!supported) return [];
  const allowed = new Set<string>();
  for (const raw of supported) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (isProjectAspectRatio(id)) allowed.add(id);
  }
  if (allowed.size === 0) return [];
  return ASPECT_CHOOSER_ORDER.filter((id) => allowed.has(id)).map(
    (id) => BY_ID.get(id)!,
  );
}

/** Prefer schema default when known; else project default; else first option. */
export function pickAspectChooserValue(
  options: readonly ProjectAspectOption[],
  preferred: string | null | undefined,
): string {
  if (options.length === 0) return "";
  const pref = preferred?.trim() ?? "";
  if (pref && options.some((o) => o.id === pref)) return pref;
  if (options.some((o) => o.id === DEFAULT_PROJECT_ASPECT_RATIO)) {
    return DEFAULT_PROJECT_ASPECT_RATIO;
  }
  return options[0].id;
}
