const DEFAULT_SUMMARY = "Generation failed.";

/** Split a raw failure string into a short alert line and full technical text. */
export function generationErrorPresentation(
  message: string | null | undefined,
): { summary: string; details: string } | null {
  const details = message?.trim();
  if (!details) return null;

  const lines = details
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0] ?? details;

  if (lines.length === 1 && details.length <= 140) {
    return {
      summary: DEFAULT_SUMMARY,
      details,
    };
  }

  const summary =
    firstLine.length > 160 ? `${firstLine.slice(0, 157).trim()}…` : firstLine;
  return { summary, details };
}
