import { isInaudibleLyricLine } from "../../lab/lyricAlign";
import type { LyricAlignment, TimelineClip } from "../../project/types";
import { resolveAlignmentAudioClip } from "./addAssetStartFrame";
import { clipInSec, clipOutSec } from "./timelineCompose";

export type TimelineLyricBlock = {
  line: string;
  startSec: number;
  endSec: number;
};

/** Map aligned song seconds to timeline seconds via the main audio clip. */
export function songSecToTimelineSec(
  audioClip: TimelineClip,
  songSec: number,
): number {
  const inSec = clipInSec(audioClip);
  const outSec = clipOutSec(audioClip);
  const clamped = Math.max(inSec, Math.min(outSec, songSec));
  return audioClip.startSec + (clamped - inSec);
}

export function timelineLyricBlocks(
  timeline: readonly TimelineClip[],
  alignment: LyricAlignment | null | undefined,
  mainAudioCreationId: string | null,
): TimelineLyricBlock[] {
  if (!alignment?.lines.length) return [];

  const audio = resolveAlignmentAudioClip(
    timeline,
    alignment,
    mainAudioCreationId,
  );
  const toTimeline = (songSec: number) =>
    audio ? songSecToTimelineSec(audio, songSec) : songSec;

  return alignment.lines
    .filter((line) => !isInaudibleLyricLine(line))
    .map((line) => ({
      line: line.line.trim(),
      startSec: toTimeline(line.startSec),
      endSec: toTimeline(line.endSec),
    }))
    .filter(
      (block) => block.line.length > 0 && block.endSec > block.startSec + 0.001,
    );
}
