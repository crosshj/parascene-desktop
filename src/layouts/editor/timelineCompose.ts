import type { TimelineClip } from "../../project/types";

/** One visual (V1) or audio (A1) contribution at a timeline time. */
export type TimelineLayer = {
  clip: TimelineClip;
  /** Seconds from clip.startSec along the timeline. */
  localSec: number;
  /**
   * Mapped source media time (inSec + localSec), clamped to [inSec, outSec].
   * Images ignore this for pixels today; Ken Burns / video seek use it later.
   */
  sourceSec: number;
};

/** Resolved program-monitor frame at timeline time `t`. */
export type TimelineFrame = {
  /** Active video-lane clip, or null in a gap. */
  visual: TimelineLayer | null;
  /** Active audio-lane clips (0–1 today; array leaves room for stacked audio). */
  audio: TimelineLayer[];
};

export function timelineSequenceDuration(clips: readonly TimelineClip[]): number {
  if (clips.length === 0) return 0;
  return clips.reduce((max, c) => Math.max(max, c.endSec), 0);
}

function clipLane(clip: TimelineClip): "video" | "audio" {
  return clip.lane === "audio" ? "audio" : "video";
}

function clipsOnLane(
  clips: readonly TimelineClip[],
  lane: "video" | "audio",
): TimelineClip[] {
  return clips.filter((c) => clipLane(c) === lane);
}

/** Source in-point; defaults to 0. */
export function clipInSec(clip: TimelineClip): number {
  return Number.isFinite(clip.inSec) ? Math.max(0, Number(clip.inSec)) : 0;
}

/** Source out-point; defaults to in + timeline duration. */
export function clipOutSec(clip: TimelineClip): number {
  const inSec = clipInSec(clip);
  const timelineDur = Math.max(0.1, clip.endSec - clip.startSec);
  if (Number.isFinite(clip.outSec) && Number(clip.outSec) > inSec) {
    return Number(clip.outSec);
  }
  return inSec + timelineDur;
}

export function clipSourceSec(clip: TimelineClip, timelineSec: number): number {
  const inSec = clipInSec(clip);
  const outSec = clipOutSec(clip);
  const local = Math.max(0, timelineSec - clip.startSec);
  return Math.min(outSec, Math.max(inSec, inSec + local));
}

function toLayer(clip: TimelineClip, timelineSec: number): TimelineLayer {
  return {
    clip,
    localSec: Math.max(0, timelineSec - clip.startSec),
    sourceSec: clipSourceSec(clip, timelineSec),
  };
}

/**
 * Half-open [startSec, endSec). At the sequence end, include the last frame
 * of any clip that ends exactly there so Play can hold the final image.
 */
function clipCovering(
  laneClips: readonly TimelineClip[],
  t: number,
  sequenceEnd: number,
): TimelineClip | null {
  let hit: TimelineClip | null = null;
  for (const c of laneClips) {
    if (t >= c.startSec && t < c.endSec) hit = c;
  }
  if (hit) return hit;
  if (sequenceEnd > 0 && t >= sequenceEnd) {
    for (const c of laneClips) {
      if (c.endSec === sequenceEnd && t >= c.startSec) hit = c;
    }
  }
  return hit;
}

/**
 * Resolve what the program monitor should show/hear at timeline time `t`.
 * Video lane → single visual layer; audio lane → all covering clips (usually one).
 */
export function resolveTimelineFrame(
  clips: readonly TimelineClip[],
  t: number,
): TimelineFrame {
  const time = Number.isFinite(t) && t > 0 ? t : 0;
  const sequenceEnd = timelineSequenceDuration(clips);
  const videoClips = clipsOnLane(clips, "video");
  const audioClips = clipsOnLane(clips, "audio");

  const visualClip = clipCovering(videoClips, time, sequenceEnd);
  const audioHits = audioClips.filter((c) => {
    if (time >= c.startSec && time < c.endSec) return true;
    return (
      sequenceEnd > 0 &&
      time >= sequenceEnd &&
      c.endSec === sequenceEnd &&
      time >= c.startSec
    );
  });

  return {
    visual: visualClip ? toLayer(visualClip, time) : null,
    audio: audioHits.map((c) => toLayer(c, time)),
  };
}
