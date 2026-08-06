export const PROJECT_TITLE_MAX_GRAPHEMES = 120;

/** Desktop project-title contract; stricter than the Folder API's 200-character limit. */
export function normalizeProjectTitle(value: string): string {
  const trimmed = value.trim() || "Untitled project";
  type SegmenterLike = new (
    locale?: string,
    opts?: { granularity: "grapheme" },
  ) => { segment(input: string): Iterable<{ segment: string }> };
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterLike }).Segmenter;
  if (!Segmenter) {
    return Array.from(trimmed)
      .slice(0, PROJECT_TITLE_MAX_GRAPHEMES)
      .join("");
  }
  const segments = new Segmenter(undefined, { granularity: "grapheme" }).segment(
    trimmed,
  );
  let out = "";
  let count = 0;
  for (const segment of segments) {
    if (count >= PROJECT_TITLE_MAX_GRAPHEMES) break;
    out += segment.segment;
    count += 1;
  }
  return out;
}
