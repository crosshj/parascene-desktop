const BANNER =
  /^(ffmpeg version|ffprobe version|Copyright \(c\)|built with|configuration:|libav|libsw|libpostproc|--)/i;

const BANNER_DUMP = /ffmpeg version/i;

/** Split a bake/ffmpeg failure into a short line plus the full log. */
export function bakeErrorPresentation(
  message: string | null | undefined,
): { summary: string; details: string } | null {
  const details = message?.trim();
  if (!details) return null;

  if (BANNER_DUMP.test(details)) {
    return {
      summary: "FFmpeg could not bake this clip.",
      details,
    };
  }

  const lines = details
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const useful = lines.filter((line) => !BANNER.test(line));
  const first = useful[0] ?? lines[0] ?? details;
  const summary =
    first.length > 160 ? `${first.slice(0, 157).trim()}…` : first;
  return { summary, details };
}
