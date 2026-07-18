import {
  clampSensitivity,
  normalizeSlideshowMode,
  type SlideshowMode,
  type SlideshowRecipe,
} from "../../project/types";

export const STAGED_CLIP_MIME = "application/x-parascene-staged-clip";

export type StagedClipKind = "video" | "image" | "audio" | "slideshow";

export type StagedClipTransform = "hold" | "kenBurns";

export type StagedClipFraming = "fit" | "fill" | "stretch";

export type { SlideshowMode, SlideshowRecipe };

export const DEFAULT_IMAGE_DURATION_SEC = 10;
/** Used only until source media duration is known; then Out becomes the real length. */
export const PROVISIONAL_VIDEO_OUT_SEC = 10;
export const PROVISIONAL_AUDIO_OUT_SEC = 30;

export function newSlideshowSeed(): number {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

/** Deterministic Fisher-Yates order shared by source Preview. */
export function slideshowOrderIndices(count: number, seed = 0): number[] {
  const out = Array.from({ length: Math.max(0, count) }, (_, i) => i);
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

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
  /** Composite slideshow recipe when kind is "slideshow". */
  slideshow?: SlideshowRecipe;
  bakeKey?: string | null;
  bakePath?: string | null;
};

export function normalizeSlideshowRecipe(
  value: unknown,
): SlideshowRecipe | undefined {
  if (!value || typeof value !== "object") return undefined;
  const s = value as Record<string, unknown>;
  if (!Array.isArray(s.imageAssetIds)) return undefined;
  const imageAssetIds = s.imageAssetIds
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
  if (imageAssetIds.length < 2) return undefined;
  // Legacy projects stored mode:"random" (even timing + shuffle).
  const legacyRandom = s.mode === "random";
  const mode = normalizeSlideshowMode(s.mode);
  const random = s.random === true || legacyRandom;
  const recipe: SlideshowRecipe = { imageAssetIds, mode };
  if (random) recipe.random = true;
  const seed = Number(s.seed);
  if (random && Number.isFinite(seed)) {
    recipe.seed = Math.trunc(seed) >>> 0;
  }
  if (typeof s.audioAssetId === "string" && s.audioAssetId.trim()) {
    recipe.audioAssetId = s.audioAssetId.trim();
  }
  const audioInSec = Number(s.audioInSec);
  const audioOutSec = Number(s.audioOutSec);
  const audioStartSec = Number(s.audioStartSec);
  const audioEndSec = Number(s.audioEndSec);
  if (Number.isFinite(audioInSec)) recipe.audioInSec = audioInSec;
  if (Number.isFinite(audioOutSec)) recipe.audioOutSec = audioOutSec;
  if (Number.isFinite(audioStartSec)) recipe.audioStartSec = audioStartSec;
  if (Number.isFinite(audioEndSec)) recipe.audioEndSec = audioEndSec;
  const sensitivity = clampSensitivity(s.sensitivity);
  if (sensitivity !== undefined) recipe.sensitivity = sensitivity;
  return recipe;
}

/** True when two slideshow recipes describe the same bake inputs. */
export function slideshowRecipesEqual(
  a: SlideshowRecipe | null | undefined,
  b: SlideshowRecipe | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.mode !== b.mode) return false;
  if (!!a.random !== !!b.random) return false;
  if (!!a.random && (a.seed ?? 0) !== (b.seed ?? 0)) return false;
  if (a.imageAssetIds.length !== b.imageAssetIds.length) return false;
  if (a.imageAssetIds.some((id, i) => id !== b.imageAssetIds[i])) return false;
  if ((a.audioAssetId ?? "") !== (b.audioAssetId ?? "")) return false;
  const numEq = (x: number | undefined, y: number | undefined) =>
    (Number.isFinite(x) ? Number(x) : null) ===
    (Number.isFinite(y) ? Number(y) : null);
  return (
    numEq(a.audioInSec, b.audioInSec) &&
    numEq(a.audioOutSec, b.audioOutSec) &&
    numEq(a.audioStartSec, b.audioStartSec) &&
    numEq(a.audioEndSec, b.audioEndSec) &&
    numEq(a.sensitivity, b.sensitivity)
  );
}

export function defaultSlideshowDraft(opts: {
  imageAssetIds: string[];
  label: string;
  thumbUrl?: string | null;
  durationSec?: number;
  mode?: SlideshowMode;
  random?: boolean;
}): StagedClipDraft {
  const imageAssetIds = opts.imageAssetIds.map((id) => id.trim()).filter(Boolean);
  const duration =
    Number.isFinite(opts.durationSec) && (opts.durationSec as number) > 0
      ? (opts.durationSec as number)
      : DEFAULT_IMAGE_DURATION_SEC;
  const random = opts.random === true;
  return {
    assetId: imageAssetIds[0] ?? "",
    label: opts.label,
    kind: "slideshow",
    inSec: 0,
    outSec: duration,
    includeAudio: false,
    reverse: false,
    transform: "hold",
    framing: "fit",
    thumbUrl: opts.thumbUrl ?? null,
    slideshow: {
      imageAssetIds,
      mode: normalizeSlideshowMode(opts.mode),
      ...(random ? { random: true, seed: newSlideshowSeed() } : {}),
    },
    bakeKey: null,
    bakePath: null,
  };
}

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

/** True when Out is still the kind placeholder (not yet filled from media duration). */
export function isProvisionalOutSec(draft: StagedClipDraft): boolean {
  if (draft.kind === "image" || draft.kind === "slideshow") return false;
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
    slideshow?: SlideshowRecipe;
    bakeKey?: string | null;
    bakePath?: string | null;
  },
  draft: StagedClipDraft,
): typeof clip {
  const duration = Math.max(0.1, stagedClipDuration(draft));
  const label =
    Number.isFinite(duration) && duration > 0
      ? `${(Math.round(duration * 10) / 10).toFixed(1)}s`
      : clip.label;
  // A rendered slideshow is source media: in/out edits only select a range
  // from that bake. Re-render only when pixels in the bake would change.
  const recipeChanged =
    draft.kind === "slideshow" &&
    (!slideshowRecipesEqual(clip.slideshow, draft.slideshow) ||
      normalizeFraming(clip.framing) !== draft.framing);
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
    slideshow: draft.kind === "slideshow" ? draft.slideshow : undefined,
    bakeKey: recipeChanged ? null : (draft.bakeKey ?? clip.bakeKey ?? null),
    bakePath: recipeChanged ? null : (draft.bakePath ?? clip.bakePath ?? null),
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
  slideshow?: SlideshowRecipe;
  bakeKey?: string | null;
  bakePath?: string | null;
}): StagedClipDraft | null {
  const slideshow =
    clip.kind === "slideshow"
      ? normalizeSlideshowRecipe(clip.slideshow)
      : undefined;
  const assetId =
    clip.assetId?.trim() ||
    slideshow?.imageAssetIds[0]?.trim() ||
    "";
  if (!assetId) return null;

  const kind: StagedClipKind =
    clip.kind === "slideshow" && slideshow
      ? "slideshow"
      : clip.kind === "image" || clip.kind === "audio" || clip.kind === "video"
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
    slideshow,
    bakeKey: typeof clip.bakeKey === "string" ? clip.bakeKey : null,
    bakePath: typeof clip.bakePath === "string" ? clip.bakePath : null,
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
    if (
      kind !== "video" &&
      kind !== "image" &&
      kind !== "audio" &&
      kind !== "slideshow"
    ) {
      return null;
    }
    if (typeof d.assetId !== "string") return null;
    const inSec = Number(d.inSec);
    const outSec = Number(d.outSec);
    if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || outSec <= inSec) {
      return null;
    }
    const slideshow =
      kind === "slideshow" ? normalizeSlideshowRecipe(d.slideshow) : undefined;
    if (kind === "slideshow" && !slideshow) return null;
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
      slideshow,
      bakeKey: typeof d.bakeKey === "string" ? d.bakeKey : null,
      bakePath: typeof d.bakePath === "string" ? d.bakePath : null,
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
