import type { LyricAlignment, ProjectAspectRatio } from "../project/types";
import { isInaudibleLyricLine } from "./lyricAlign";

export type LyricStructureLine = {
  line: string;
  startSec: number;
  endSec: number;
  inaudible: boolean;
  lineIndex: number;
};

export function songDurationFromAlignment(
  alignment: LyricAlignment | null,
): number {
  if (!alignment?.lines.length) return 0;
  return Math.max(
    ...alignment.lines.map((l) => l.endSec),
    0,
  );
}

export function buildLyricStructure(
  alignment: LyricAlignment,
): LyricStructureLine[] {
  return alignment.lines.map((line, lineIndex) => ({
    line: line.line,
    startSec: line.startSec,
    endSec: line.endSec,
    inaudible: isInaudibleLyricLine(line),
    lineIndex,
  }));
}

export function compactVocalActivity(
  blocks?: Array<{ startSec: number; endSec: number }>,
): Array<{ startSec: number; endSec: number }> | undefined {
  if (!blocks?.length) return undefined;
  return blocks.map((b) => ({
    startSec: Number(b.startSec.toFixed(2)),
    endSec: Number(b.endSec.toFixed(2)),
  }));
}

export const STORYBOARD_PRODUCTION_AWARENESS = {
  maxShotSec: 9,
  cheapOps: ["loop_clip", "extend_clip", "lyric_card"],
  mediumOps: ["mutate_still"],
  expensiveOps: ["new_still", "new_video", "a2v_from_still"],
  a2vRequiresUniqueVocalSlice: true,
  extendAvailable: true,
} as const;

export function aspectFramingNote(aspectRatio: ProjectAspectRatio): string {
  switch (aspectRatio) {
    case "9:16":
      return "Vertical portrait framing (9:16)";
    case "1:1":
      return "Square framing (1:1)";
    case "4:5":
      return "Portrait framing (4:5)";
    default:
      return "Landscape widescreen framing (16:9)";
  }
}

export function countSungLines(alignment: LyricAlignment | null): number {
  if (!alignment) return 0;
  return alignment.lines.filter((l) => !isInaudibleLyricLine(l)).length;
}
