export const STAGED_CLIP_MIME = "application/x-parascene-staged-clip";

export type StagedClipKind = "video" | "image" | "audio";

export type StagedClipTransform = "hold" | "kenBurns";

export type StagedClipFraming = "fit" | "fill" | "stretch";

/** Normalize unknown / missing framing to a concrete preview/export mode. */
export function normalizeFraming(
  framing: StagedClipFraming | string | null | undefined,
): StagedClipFraming {
  return framing === "fill" || framing === "stretch" ? framing : "fit";
}

/** CSS modifier for `.editor-preview-media` object-fit modes. */
export function framingClassName(framing: StagedClipFraming): string {
  if (framing === "fill") return "is-framing-fill";
  if (framing === "stretch") return "is-framing-stretch";
  return "is-framing-fit";
}

/**
 * Fill/Stretch map into the project aspect matte. Fit contains into the 16:9
 * preview stage (matte then shows the export crop).
 */
export function framingUsesProjectMatte(framing: StagedClipFraming): boolean {
  return framing === "fill" || framing === "stretch";
}

/**
 * Position a media viewport inside the 16:9 stage. `undefined` → full stage
 * (`inset: 0`). Fill/Stretch shrink to the centered project matte so framing
 * matches export (which scales to the project frame, not the stage).
 */
export function framingViewportStyle(
  framing: StagedClipFraming,
  stageW: number,
  stageH: number,
  matteW: number,
  matteH: number,
): { width: number; height: number; left: number; top: number } | undefined {
  if (!framingUsesProjectMatte(framing)) return undefined;
  if (matteW <= 0 || matteH <= 0 || stageW <= 0 || stageH <= 0) {
    return undefined;
  }
  if (matteW >= stageW && matteH >= stageH) return undefined;
  return {
    width: matteW,
    height: matteH,
    left: Math.round((stageW - matteW) / 2),
    top: Math.round((stageH - matteH) / 2),
  };
}

/**
 * Chromium/Electron often ignores `object-fit: fill` on `<video>`. Stretch by
 * painting with contain, then non-uniformly scaling so letterbox bars vanish.
 * Parent must clip (`overflow: hidden`). `boxW`/`boxH` must be the project
 * frame (matte), not the 16:9 stage, when the project aspect differs.
 */
export function videoStretchStyle(
  mediaW: number,
  mediaH: number,
  boxW: number,
  boxH: number,
): { objectFit: "contain"; transform: string; transformOrigin: string } | null {
  if (mediaW <= 0 || mediaH <= 0 || boxW <= 0 || boxH <= 0) return null;
  const contain = Math.min(boxW / mediaW, boxH / mediaH);
  const fittedW = mediaW * contain;
  const fittedH = mediaH * contain;
  if (fittedW <= 0 || fittedH <= 0) return null;
  return {
    objectFit: "contain",
    transform: `scale(${boxW / fittedW}, ${boxH / fittedH})`,
    transformOrigin: "center center",
  };
}

export type StagedClipDraft = {
  assetId: string;
  label: string;
  kind: StagedClipKind;
  inSec: number;
  outSec: number;
  includeAudio: boolean;
  /** Use a cached FFmpeg-reversed copy of the source asset. */
  reverse: boolean;
  transform: StagedClipTransform;
  framing: StagedClipFraming;
  thumbUrl: string | null;
};

/**
 * Mirror in/out across the source duration when toggling reverse so the same
 * visual segment stays selected on the reversed file.
 */
export function remapTrimForReverse(
  draft: StagedClipDraft,
  durationSec: number,
): Pick<StagedClipDraft, "inSec" | "outSec"> {
  const d =
    Number.isFinite(durationSec) && durationSec > 0
      ? durationSec
      : Math.max(draft.outSec, draft.inSec + 0.1);
  const inSec = Math.max(0, Math.min(d, d - draft.outSec));
  const outSec = Math.max(inSec + 0.1, Math.min(d, d - draft.inSec));
  return { inSec, outSec };
}

export const DEFAULT_IMAGE_DURATION_SEC = 10;
/** Used only until source media duration is known; then Out becomes the real length. */
export const PROVISIONAL_VIDEO_OUT_SEC = 10;
export const PROVISIONAL_AUDIO_OUT_SEC = 30;

/** True when Out is still the kind placeholder (not yet filled from media duration). */
export function isProvisionalOutSec(draft: StagedClipDraft): boolean {
  if (draft.kind === "image") return false;
  const provisional =
    draft.kind === "audio"
      ? PROVISIONAL_AUDIO_OUT_SEC
      : PROVISIONAL_VIDEO_OUT_SEC;
  return draft.outSec <= 0 || Math.abs(draft.outSec - provisional) < 0.05;
}

export function stagedClipDuration(draft: StagedClipDraft): number {
  return Math.max(0, draft.outSec - draft.inSec);
}

/** Apply staging edits onto an existing timeline clip (keep start, resize duration). */
export function applyDraftToTimelineClip(
  clip: {
    id: string;
    label: string;
    startSec: number;
    endSec: number;
    assetId?: string;
    thumbUrl?: string | null;
    lane?: "video" | "audio";
    kind?: StagedClipKind;
    inSec?: number;
    outSec?: number;
    includeAudio?: boolean;
    reverse?: boolean;
    transform?: StagedClipTransform;
    framing?: StagedClipFraming;
  },
  draft: StagedClipDraft,
): typeof clip {
  const duration = Math.max(0.1, stagedClipDuration(draft));
  const label =
    Number.isFinite(duration) && duration > 0
      ? `${(Math.round(duration * 10) / 10).toFixed(1)}s`
      : clip.label;
  return {
    ...clip,
    label,
    endSec: clip.startSec + duration,
    assetId: draft.assetId,
    thumbUrl: draft.thumbUrl,
    kind: draft.kind,
    inSec: draft.inSec,
    outSec: draft.outSec,
    includeAudio: draft.includeAudio,
    reverse: draft.reverse,
    transform: draft.transform,
    framing: draft.framing,
  };
}

export function formatStagedDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const tenths = Math.round((sec % 1) * 10);
  if (tenths > 0 && sec < 10) {
    return `${m}:${String(s).padStart(2, "0")}.${tenths}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function defaultStagedClipDraft(opts: {
  assetId: string;
  label: string;
  kind: StagedClipKind;
  sourceDurationSec?: number;
  thumbUrl?: string | null;
}): StagedClipDraft {
  const { assetId, label, kind, thumbUrl = null } = opts;
  const sourceDuration = opts.sourceDurationSec ?? 0;

  if (kind === "image") {
    return {
      assetId,
      label,
      kind,
      inSec: 0,
      outSec: DEFAULT_IMAGE_DURATION_SEC,
      includeAudio: false,
      reverse: false,
      transform: "hold",
      framing: "fit",
      thumbUrl,
    };
  }

  const out =
    sourceDuration > 0
      ? sourceDuration
      : kind === "audio"
        ? PROVISIONAL_AUDIO_OUT_SEC
        : PROVISIONAL_VIDEO_OUT_SEC;

  return {
    assetId,
    label,
    kind,
    inSec: 0,
    outSec: out,
    includeAudio: false,
    reverse: false,
    transform: "hold",
    framing: "fit",
    thumbUrl,
  };
}

/** Rebuild staging fields from a timeline clip (for selection → preview). */
export function timelineClipToStagedDraft(clip: {
  assetId?: string;
  label: string;
  lane?: "video" | "audio";
  kind?: StagedClipKind;
  inSec?: number;
  outSec?: number;
  startSec: number;
  endSec: number;
  includeAudio?: boolean;
  reverse?: boolean;
  transform?: StagedClipTransform;
  framing?: StagedClipFraming;
  thumbUrl?: string | null;
}): StagedClipDraft | null {
  const assetId = clip.assetId?.trim();
  if (!assetId) return null;

  const kind: StagedClipKind =
    clip.kind === "image" || clip.kind === "audio" || clip.kind === "video"
      ? clip.kind
      : clip.lane === "audio"
        ? "audio"
        : "video";

  const timelineDur = Math.max(0.1, clip.endSec - clip.startSec);
  const inSec = Number.isFinite(clip.inSec) ? Math.max(0, Number(clip.inSec)) : 0;
  let outSec = Number.isFinite(clip.outSec)
    ? Number(clip.outSec)
    : inSec + timelineDur;
  if (!(outSec > inSec)) outSec = inSec + timelineDur;

  const transform: StagedClipTransform =
    clip.transform === "kenBurns" ? "kenBurns" : "hold";
  const framing = normalizeFraming(clip.framing);

  return {
    assetId,
    // Clip.label on the timeline is the duration chip; catalog title fills in later.
    label: assetId,
    kind,
    inSec,
    outSec,
    // Include-audio only applies to video clips (muxed soundtrack).
    includeAudio:
      kind === "video"
        ? typeof clip.includeAudio === "boolean"
          ? clip.includeAudio
          : true
        : false,
    reverse: Boolean(clip.reverse),
    transform,
    framing,
    thumbUrl: typeof clip.thumbUrl === "string" ? clip.thumbUrl : null,
  };
}

export function targetLaneForDraft(draft: StagedClipDraft): "video" | "audio" {
  return draft.kind === "audio" ? "audio" : "video";
}

export function serializeStagedClip(draft: StagedClipDraft): string {
  return JSON.stringify(draft);
}

export function parseStagedClipPayload(raw: string): StagedClipDraft | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const d = parsed as Record<string, unknown>;
    const kind = d.kind;
    if (kind !== "video" && kind !== "image" && kind !== "audio") return null;
    if (typeof d.assetId !== "string") return null;
    const inSec = Number(d.inSec);
    const outSec = Number(d.outSec);
    if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || outSec <= inSec) {
      return null;
    }
    return {
      assetId: d.assetId,
      label: typeof d.label === "string" ? d.label : d.assetId,
      kind,
      inSec,
      outSec,
      includeAudio: Boolean(d.includeAudio),
      reverse: Boolean(d.reverse),
      transform: d.transform === "kenBurns" ? "kenBurns" : "hold",
      framing: normalizeFraming(
        typeof d.framing === "string" ? d.framing : undefined,
      ),
      thumbUrl: typeof d.thumbUrl === "string" ? d.thumbUrl : null,
    };
  } catch {
    return null;
  }
}

export function readStagedClipFromDataTransfer(
  dt: DataTransfer,
): StagedClipDraft | null {
  const raw = dt.getData(STAGED_CLIP_MIME);
  if (!raw) return null;
  return parseStagedClipPayload(raw);
}

/** Shared px-per-sec for timeline ghost positioning. */
export const TIMELINE_PX_PER_SEC = 8;

export type TimelineGhostClip = {
  startSec: number;
  durationSec: number;
  lane: "video" | "audio";
  label: string;
  thumbUrl: string | null;
};

/** Active staged-clip drag (HTML5 getData is drop-only in most browsers). */
let activeStagedClipDrag: StagedClipDraft | null = null;

type StagedClipDragListener = (draft: StagedClipDraft | null) => void;
const stagedClipDragListeners = new Set<StagedClipDragListener>();

export function setActiveStagedClipDrag(draft: StagedClipDraft | null): void {
  activeStagedClipDrag = draft;
  for (const listener of stagedClipDragListeners) listener(draft);
}

export function getActiveStagedClipDrag(): StagedClipDraft | null {
  return activeStagedClipDrag;
}

export function subscribeStagedClipDrag(
  listener: StagedClipDragListener,
): () => void {
  stagedClipDragListeners.add(listener);
  return () => {
    stagedClipDragListeners.delete(listener);
  };
}

/** Last pointer position during an active staged-clip drag. */
let stagedClipPointer: { x: number; y: number } | null = null;

type StagedClipPointerListener = (point: {
  x: number;
  y: number;
} | null) => void;
const stagedClipPointerListeners = new Set<StagedClipPointerListener>();

export function setStagedClipPointer(
  point: { x: number; y: number } | null,
): void {
  stagedClipPointer = point;
  for (const listener of stagedClipPointerListeners) listener(point);
}

export function getStagedClipPointer(): { x: number; y: number } | null {
  return stagedClipPointer;
}

export function subscribeStagedClipPointer(
  listener: StagedClipPointerListener,
): () => void {
  stagedClipPointerListeners.add(listener);
  return () => {
    stagedClipPointerListeners.delete(listener);
  };
}

export function clearStagedClipDrag(): void {
  activeStagedClipDrag = null;
  stagedClipPointer = null;
  for (const listener of stagedClipDragListeners) listener(null);
  for (const listener of stagedClipPointerListeners) listener(null);
}
