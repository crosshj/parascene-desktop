/** SourceBuffer.buffered helpers. Sequential CMAF fragments must be one range. */

export type BufferedRange = {
  start: number;
  end: number;
};

export function timeRangesToArray(
  ranges: Pick<TimeRanges, "length" | "start" | "end">,
): BufferedRange[] {
  const out: BufferedRange[] = [];
  for (let i = 0; i < ranges.length; i += 1) {
    out.push({ start: ranges.start(i), end: ranges.end(i) });
  }
  return out;
}

/** `[0.000, 8.000]` or `[0.000, 1.980] [2.000, 3.980]`. */
export function formatBufferedRanges(ranges: readonly BufferedRange[]): string {
  if (ranges.length === 0) return "(empty)";
  return ranges
    .map((range) => `[${range.start.toFixed(3)}, ${range.end.toFixed(3)}]`)
    .join(" ");
}

/**
 * True when ranges merge into a single interval. A 20ms hole (e.g. 1.98 → 2.00)
 * is a gap — do not treat it as continuous.
 */
export function bufferedIsContinuous(
  ranges: readonly BufferedRange[],
  epsilonSec = 0.001,
): boolean {
  if (ranges.length <= 1) return true;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    if (next.start - prev.end > epsilonSec) return false;
  }
  return true;
}
