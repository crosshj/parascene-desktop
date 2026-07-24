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

/** Trimmed source span from explicit in/out only (ignores timeline fallback). */
export function clipSourceTrimSpanSec(clip: TimelineClip): number | null {
  const inSec = clipInSec(clip);
  if (!Number.isFinite(clip.outSec) || Number(clip.outSec) <= inSec) {
    return null;
  }
  return Math.max(0.1, Number(clip.outSec) - inSec);
}

/** Source trim span used for extend UI and playback looping. */
export function clipExtendSourceSpanSec(clip: TimelineClip): number | null {
  if (
    Number.isFinite(clip.extendSourceSpanSec) &&
    Number(clip.extendSourceSpanSec) > 0
  ) {
    return Math.max(0.1, Number(clip.extendSourceSpanSec));
  }
  return clipSourceTrimSpanSec(clip);
}

/** True when timeline placement is longer than the trimmed source region. */
export function clipIsTimelineExtended(clip: TimelineClip): boolean {
  if (
    clip.kind === "image" ||
    clip.kind === "slideshow" ||
    clip.kind === "audio" ||
    clip.lane === "audio"
  ) {
    return false;
  }
  const trimSpan = clipExtendSourceSpanSec(clip);
  if (trimSpan == null) return false;
  return clipTimelineDurationSec(clip) > trimSpan + 0.001;
}

/** 0..1 position along the clip where the source trim ends (extend divit). */
export function clipExtendDivitFraction(clip: TimelineClip): number | null {
  if (!clipIsTimelineExtended(clip)) return null;
  const trimSpan = clipExtendSourceSpanSec(clip);
  if (trimSpan == null) return null;
  return trimSpan / clipTimelineDurationSec(clip);
}

/** Trimmed source media span (out − in). */
export function clipSourceSpanSec(clip: TimelineClip): number {
  const trimSpan = clipExtendSourceSpanSec(clip);
  if (trimSpan != null) return trimSpan;
  return clipTimelineDurationSec(clip);
}

export function clipVideoMinTimelineDurationSec(clip: TimelineClip): number {
  const frozen = clipExtendSourceSpanSec(clip);
  if (frozen != null) return frozen;
  return clipTimelineDurationSec(clip);
}

/** Timeline placement span (end − start). */
export function clipTimelineDurationSec(clip: TimelineClip): number {
  return Math.max(0.1, clip.endSec - clip.startSec);
}

export function clipSourceSec(clip: TimelineClip, timelineSec: number): number {
  const inSec = clipInSec(clip);
  const outSec = clipOutSec(clip);
  const sourceSpan = clipSourceSpanSec(clip);
  const local = Math.max(0, timelineSec - clip.startSec);
  const timelineDur = clipTimelineDurationSec(clip);

  if (
    clip.kind !== "video" ||
    local <= sourceSpan + 1e-6 ||
    timelineDur <= sourceSpan + 1e-6
  ) {
    return Math.min(outSec, Math.max(inSec, inSec + local));
  }

  const extendLocal = local - sourceSpan;
  if (clip.extendPingPong !== true) {
    return inSec + (extendLocal % sourceSpan);
  }

  const segment = Math.floor(extendLocal / sourceSpan);
  const phase = extendLocal % sourceSpan;
  if (segment % 2 === 0) {
    return outSec - phase;
  }
  return inSec + phase;
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

/**
 * Next video-lane clip that begins after the visual covering `t` (or after `t`
 * when in a gap). Used for look-ahead priming of the program monitor.
 */
export function peekNextVisualClip(
  clips: readonly TimelineClip[],
  t: number,
): TimelineClip | null {
  const time = Number.isFinite(t) && t > 0 ? t : 0;
  const sequenceEnd = timelineSequenceDuration(clips);
  const videoClips = clipsOnLane(clips, "video")
    .slice()
    .sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id));
  if (videoClips.length === 0) return null;

  const current = clipCovering(videoClips, time, sequenceEnd);
  const gate = current ? current.endSec : time;

  for (const c of videoClips) {
    if (current && c.id === current.id) continue;
    if (c.startSec + 1e-6 >= gate) return c;
  }
  return null;
}

/** Layer at a clip's timeline start (source in-point) for standby priming. */
export function layerAtClipStart(clip: TimelineClip): TimelineLayer {
  return toLayer(clip, clip.startSec);
}
