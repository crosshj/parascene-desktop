import type { TimelineClip } from "../../project/types";
import type { FrameTarget } from "../../preview/types";

/** One visual (V1) or audio (A1) contribution at a timeline time. */
export type TimelineLayer = {
  clip: TimelineClip;
  /** Seconds from clip.startSec along the timeline. */
  localSec: number;
  /**
   * Mapped source media time (inSec + localSec), clamped to [inSec, outSec].
   * For reverse clips this is still the forward-source mapping; reverse remap
   * happens in `resolveFrameTarget`.
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

function secToUs(sec: number): number {
  return Math.round(Math.max(0, sec) * 1e6);
}

/**
 * Map timeline time to a FrameProvider request. Reverse clips remap onto the
 * forward proxy (no reversed file required for canvas preview).
 */
export function resolveFrameTarget(
  clips: readonly TimelineClip[],
  timelineTimeUs: number,
): FrameTarget | null {
  const tSec = timelineTimeUs / 1e6;
  const frame = resolveTimelineFrame(clips, tSec);
  const visual = frame.visual;
  if (!visual?.clip.assetId?.trim()) return null;
  if (visual.clip.kind === "audio") return null;

  const assetId = visual.clip.assetId.trim();
  const clipId = visual.clip.id;
  if (visual.clip.kind === "image") {
    return {
      assetId,
      sourceTimeUs: 0,
      clipId,
      kind: "image",
    };
  }

  let sourceSec = visual.sourceSec;
  if (visual.clip.reverse) {
    const inSec = clipInSec(visual.clip);
    const outSec = clipOutSec(visual.clip);
    sourceSec = outSec - (sourceSec - inSec);
  }

  return {
    assetId,
    sourceTimeUs: secToUs(sourceSec),
    clipId,
    kind: "video",
  };
}

/** Seam neighbors for preload when the playhead is near a cut. */
export type SeamPreload = {
  outgoing: { assetId: string; startTimeUs: number; endTimeUs: number } | null;
  incoming: { assetId: string; startTimeUs: number; endTimeUs: number } | null;
};

const SEAM_WINDOW_SEC = 0.35;

export function resolveSeamPreload(
  clips: readonly TimelineClip[],
  timelineSec: number,
): SeamPreload {
  const frame = resolveTimelineFrame(clips, timelineSec);
  const next = peekNextVisualClip(clips, timelineSec);
  const visual = frame.visual;

  let outgoing: SeamPreload["outgoing"] = null;
  let incoming: SeamPreload["incoming"] = null;

  if (visual?.clip.assetId?.trim() && visual.clip.kind !== "image") {
    const end = visual.clip.endSec;
    if (end - timelineSec <= SEAM_WINDOW_SEC) {
      const outSec = clipOutSec(visual.clip);
      const inSec = clipInSec(visual.clip);
      let start = Math.max(inSec, outSec - SEAM_WINDOW_SEC);
      let endSrc = outSec;
      if (visual.clip.reverse) {
        start = inSec;
        endSrc = Math.min(outSec, inSec + SEAM_WINDOW_SEC);
      }
      outgoing = {
        assetId: visual.clip.assetId.trim(),
        startTimeUs: secToUs(start),
        endTimeUs: secToUs(endSrc),
      };
    }
  }

  if (
    next?.assetId?.trim() &&
    next.kind !== "image" &&
    next.startSec - timelineSec <= SEAM_WINDOW_SEC
  ) {
    const inSec = clipInSec(next);
    const outSec = clipOutSec(next);
    let start = inSec;
    let endSrc = Math.min(outSec, inSec + SEAM_WINDOW_SEC);
    if (next.reverse) {
      start = Math.max(inSec, outSec - SEAM_WINDOW_SEC);
      endSrc = outSec;
    }
    incoming = {
      assetId: next.assetId.trim(),
      startTimeUs: secToUs(start),
      endTimeUs: secToUs(endSrc),
    };
  }

  return { outgoing, incoming };
}
