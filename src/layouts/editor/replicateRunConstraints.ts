/**
 * Schema-driven early guards for Replicate timeline video fill.
 * Validate as soon as model / duration / aspect / continuity / inputs change —
 * Generate only mirrors this result; predict re-checks before any network.
 */

import type { ReplicateInputField } from "../../replicate/replicateClient";

export type ReplicateVideoContinuity =
  | "start_frame"
  | "first_last"
  | "motion_match";

export type DurationConstraint =
  | { kind: "enum"; values: number[] }
  | { kind: "range"; min: number; max: number };

export type AspectConstraint = {
  /** Allowed ratios from schema enum (may include "adaptive"). */
  values: string[];
  /** Schema says aspect is ignored when a start/reference image is provided. */
  ignoredWithImage: boolean;
};

export type ReplicateFieldMap = {
  prompt: string | null;
  duration: string | null;
  aspectRatio: string | null;
  startImage: string | null;
  endImage: string | null;
  /** Character / subject still for motion match. */
  characterImage: string | null;
  /** Motion reference video. */
  motionVideo: string | null;
};

export type ReplicateVideoCapability = {
  startOnly: boolean;
  startEnd: boolean;
  motionControl: boolean;
};

export type ReplicateRunValidation = {
  ok: boolean;
  /** Human-readable blockers (any → Generate disabled). */
  blockers: string[];
  /** Non-blocking notes (aspect ignored, duration snap chosen, etc.). */
  notes: string[];
  /** Integer seconds to send when duration is constrained; null if unconstrained. */
  predictDurationSec: number | null;
  /** True when predict duration differs from clip length because of an explicit snap. */
  durationSnapped: boolean;
  /** Aspect value to send, or null to omit. */
  predictAspect: string | null;
};

function fieldByName(
  inputs: readonly ReplicateInputField[],
  name: string,
): ReplicateInputField | undefined {
  return inputs.find((f) => f.name === name);
}

function hasField(
  inputs: readonly ReplicateInputField[],
  name: string,
): boolean {
  return inputs.some((f) => f.name === name);
}

/** Map OpenAPI input names used across Seedance / Veo / Kling / Vidu / motion-control. */
export function mapReplicateVideoFields(
  inputs: readonly ReplicateInputField[],
): ReplicateFieldMap {
  const startImage = hasField(inputs, "start_image")
    ? "start_image"
    : hasField(inputs, "image")
      ? "image"
      : null;
  const endImage = hasField(inputs, "end_image")
    ? "end_image"
    : hasField(inputs, "last_frame")
      ? "last_frame"
      : hasField(inputs, "last_frame_image")
        ? "last_frame_image"
        : null;
  const motionVideo = hasField(inputs, "video")
    ? "video"
    : hasField(inputs, "reference_video")
      ? "reference_video"
      : null;
  // Motion-control uses `image` as character; when start+end exist, prefer start_image for gen.
  const characterImage = hasField(inputs, "image")
    ? "image"
    : startImage;
  return {
    prompt: hasField(inputs, "prompt") ? "prompt" : null,
    duration: hasField(inputs, "duration") ? "duration" : null,
    aspectRatio: hasField(inputs, "aspect_ratio") ? "aspect_ratio" : null,
    startImage,
    endImage,
    characterImage,
    motionVideo,
  };
}

export function replicateHasReferencePackage(
  inputs: readonly ReplicateInputField[],
): boolean {
  return (
    hasField(inputs, "reference_image_urls") ||
    hasField(inputs, "reference_images") ||
    hasField(inputs, "reference_video_urls") ||
    hasField(inputs, "reference_videos") ||
    hasField(inputs, "reference_audio_urls")
  );
}

export function replicateVideoCapability(
  inputs: readonly ReplicateInputField[],
): ReplicateVideoCapability {
  const map = mapReplicateVideoFields(inputs);
  const startOnly = Boolean(map.startImage);
  const startEnd = Boolean(map.startImage && map.endImage);
  // Motion control: video ref + image, without a distinct end-frame pair
  // (kling-v3-motion-control) OR explicit reference_video + image.
  const motionControl = Boolean(
    map.motionVideo &&
      map.characterImage &&
      (!map.endImage || map.motionVideo === "reference_video"),
  );
  return { startOnly, startEnd, motionControl };
}

export function supportsContinuity(
  capability: ReplicateVideoCapability,
  continuity: ReplicateVideoContinuity,
): boolean {
  if (continuity === "first_last") return capability.startEnd;
  if (continuity === "motion_match") return capability.motionControl;
  return capability.startOnly;
}

export function durationConstraintFromField(
  field: ReplicateInputField | undefined,
): DurationConstraint | null {
  if (!field) return null;
  const fromEnum = (field.enumValues ?? [])
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (fromEnum.length > 0) {
    return { kind: "enum", values: [...new Set(fromEnum)] };
  }
  let min = field.minimum ?? 1;
  const max = field.maximum ?? 15;
  // Seedance uses -1 for "adaptive"; treat as no lower bound for timeline fill.
  if (min < 0) min = 1;
  if (!(max >= min)) return null;
  return { kind: "range", min, max };
}

export function aspectConstraintFromField(
  field: ReplicateInputField | undefined,
): AspectConstraint | null {
  if (!field) return null;
  const values = (field.enumValues ?? [])
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (values.length === 0) return null;
  const desc = `${field.description ?? ""} ${field.title ?? ""}`.toLowerCase();
  const ignoredWithImage =
    desc.includes("ignored") &&
    (desc.includes("image") || desc.includes("start"));
  return { values, ignoredWithImage };
}

/** Nearest allowed duration; null if constraint empty. */
export function nearestAllowedDuration(
  durationSec: number,
  constraint: DurationConstraint,
): number {
  if (constraint.kind === "enum") {
    const values = constraint.values;
    let best = values[0]!;
    let bestDist = Math.abs(durationSec - best);
    for (const v of values) {
      const d = Math.abs(durationSec - v);
      if (d < bestDist) {
        best = v;
        bestDist = d;
      }
    }
    return best;
  }
  const rounded = Math.round(durationSec);
  return Math.min(constraint.max, Math.max(constraint.min, rounded));
}

export function durationFits(
  durationSec: number,
  constraint: DurationConstraint,
): boolean {
  if (constraint.kind === "enum") {
    const rounded = Math.round(durationSec);
    return (
      constraint.values.includes(rounded) ||
      constraint.values.includes(durationSec)
    );
  }
  const rounded = Math.round(durationSec);
  return rounded >= constraint.min && rounded <= constraint.max;
}

export function formatDurationConstraint(constraint: DurationConstraint): string {
  if (constraint.kind === "enum") {
    return constraint.values.join(", ") + "s";
  }
  return `${constraint.min}–${constraint.max}s`;
}

export type ValidateReplicateRunOpts = {
  inputs: readonly ReplicateInputField[];
  continuity: ReplicateVideoContinuity;
  durationSec: number;
  aspectRatio: string;
  /** User explicitly opted into nearest allowed duration. */
  useNearestDuration?: boolean;
  hasStartFrame: boolean;
  hasEndFrame: boolean;
  hasCharacterImage: boolean;
  hasMotionVideo: boolean;
  prompt: string;
};

/**
 * Early validation for a Replicate timeline fill run.
 * Pure — safe to call on every model/duration/aspect/input change.
 */
export function validateReplicateRun(
  opts: ValidateReplicateRunOpts,
): ReplicateRunValidation {
  const blockers: string[] = [];
  const notes: string[] = [];
  const map = mapReplicateVideoFields(opts.inputs);
  const capability = replicateVideoCapability(opts.inputs);

  if (!supportsContinuity(capability, opts.continuity)) {
    blockers.push(
      opts.continuity === "first_last"
        ? "This model does not support first + last frame (start–end) inputs."
        : opts.continuity === "motion_match"
          ? "This model does not support motion match (character image + reference video)."
          : "This model does not support start-frame continuation.",
    );
  }

  if (!opts.prompt.trim() && map.prompt) {
    blockers.push("Enter a prompt before generating.");
  }

  if (opts.continuity === "first_last") {
    if (!opts.hasStartFrame) {
      blockers.push("Place this clip after another clip for a first frame.");
    }
    if (!opts.hasEndFrame) {
      blockers.push("Place this clip before another clip for a last frame.");
    }
  } else if (opts.continuity === "motion_match") {
    if (!opts.hasCharacterImage) {
      blockers.push("Need a character still (from the previous clip or a pick).");
    }
    if (!opts.hasMotionVideo) {
      blockers.push(
        "Need a motion reference video (previous clip on the timeline).",
      );
    }
  } else if (!opts.hasStartFrame) {
    blockers.push("Place this clip after another clip for a start frame.");
  }

  const durationField = map.duration
    ? fieldByName(opts.inputs, map.duration)
    : undefined;
  const durationConstraint = durationConstraintFromField(durationField);
  let predictDurationSec: number | null = null;
  let durationSnapped = false;

  if (durationConstraint) {
    if (durationFits(opts.durationSec, durationConstraint)) {
      predictDurationSec =
        durationConstraint.kind === "enum"
          ? nearestAllowedDuration(opts.durationSec, durationConstraint)
          : Math.round(opts.durationSec);
      if (
        Math.abs(predictDurationSec - opts.durationSec) >= 0.05 &&
        durationConstraint.kind === "range"
      ) {
        notes.push(
          `Duration will be sent as ${predictDurationSec}s (models expect whole seconds).`,
        );
      }
    } else if (opts.useNearestDuration) {
      predictDurationSec = nearestAllowedDuration(
        opts.durationSec,
        durationConstraint,
      );
      durationSnapped = true;
      notes.push(
        `Using nearest allowed duration ${predictDurationSec}s (gap is ${opts.durationSec.toFixed(1)}s; model allows ${formatDurationConstraint(durationConstraint)}).`,
      );
    } else {
      const nearest = nearestAllowedDuration(
        opts.durationSec,
        durationConstraint,
      );
      blockers.push(
        `This gap is ${opts.durationSec.toFixed(1)}s; this model allows ${formatDurationConstraint(durationConstraint)}. Shorten the placeholder, pick another model, or use nearest (${nearest}s).`,
      );
    }
  }

  const aspectField = map.aspectRatio
    ? fieldByName(opts.inputs, map.aspectRatio)
    : undefined;
  const aspectConstraint = aspectConstraintFromField(aspectField);
  let predictAspect: string | null = null;
  const usesImageInput =
    (opts.continuity === "first_last" && opts.hasStartFrame) ||
    (opts.continuity === "start_frame" && opts.hasStartFrame) ||
    (opts.continuity === "motion_match" && opts.hasCharacterImage);

  if (aspectConstraint) {
    if (aspectConstraint.ignoredWithImage && usesImageInput) {
      notes.push("Aspect ratio is ignored when an image input is provided.");
      predictAspect = null;
    } else if (
      aspectConstraint.values.includes(opts.aspectRatio) ||
      aspectConstraint.values.includes("adaptive")
    ) {
      predictAspect = aspectConstraint.values.includes(opts.aspectRatio)
        ? opts.aspectRatio
        : "adaptive";
    } else {
      blockers.push(
        `Project aspect ${opts.aspectRatio} is not supported by this model (${aspectConstraint.values.join(", ")}). Change the project aspect or pick another model.`,
      );
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    notes,
    predictDurationSec,
    durationSnapped,
    predictAspect,
  };
}

/** Why a model is incompatible with the current run context (for picker). */
export function modelIncompatibilityReason(
  inputs: readonly ReplicateInputField[],
  continuity: ReplicateVideoContinuity,
  durationSec: number,
  aspectRatio: string,
  hasImageInput: boolean,
): string | null {
  const capability = replicateVideoCapability(inputs);
  if (!supportsContinuity(capability, continuity)) {
    if (continuity === "first_last") return "No start–end frames";
    if (continuity === "motion_match") return "No motion control";
    return "No start image";
  }
  const map = mapReplicateVideoFields(inputs);
  const durationConstraint = durationConstraintFromField(
    map.duration ? fieldByName(inputs, map.duration) : undefined,
  );
  if (durationConstraint && !durationFits(durationSec, durationConstraint)) {
    return `Allows ${formatDurationConstraint(durationConstraint)}`;
  }
  const aspectConstraint = aspectConstraintFromField(
    map.aspectRatio ? fieldByName(inputs, map.aspectRatio) : undefined,
  );
  if (
    aspectConstraint &&
    !(aspectConstraint.ignoredWithImage && hasImageInput) &&
    !aspectConstraint.values.includes(aspectRatio) &&
    !aspectConstraint.values.includes("adaptive")
  ) {
    return `No ${aspectRatio}`;
  }
  return null;
}
