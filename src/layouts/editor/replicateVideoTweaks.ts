/**
 * Optional Replicate video params shown in the editor when the selected
 * model's schema supports them (resolution/mode, audio, negative prompt, seed,
 * motion-match orientation / keep sound).
 */

import type { ReplicateInputField } from "../../replicate/replicateClient";

/** Persisted / draft tweak values (only fields the user set or defaults we apply). */
export type ReplicateVideoTweaks = {
  resolution?: string;
  mode?: string;
  /** Maps to `generate_audio` or `audio`. Timeline default: false. */
  generateAudio?: boolean;
  negativePrompt?: string;
  /** Omit from predict when null/undefined. */
  seed?: number | null;
  characterOrientation?: string;
  keepOriginalSound?: boolean;
};

export type ReplicateTweakFields = {
  resolution: ReplicateInputField | null;
  mode: ReplicateInputField | null;
  /** Schema field name for the audio boolean. */
  audio: { name: string; field: ReplicateInputField } | null;
  negativePrompt: ReplicateInputField | null;
  seed: ReplicateInputField | null;
  characterOrientation: ReplicateInputField | null;
  keepOriginalSound: ReplicateInputField | null;
};

function fieldNamed(
  inputs: readonly ReplicateInputField[],
  name: string,
): ReplicateInputField | null {
  return inputs.find((f) => f.name === name) ?? null;
}

/** Discover which tweak controls the selected model supports. */
export function discoverReplicateTweakFields(
  inputs: readonly ReplicateInputField[],
): ReplicateTweakFields {
  const generateAudio = fieldNamed(inputs, "generate_audio");
  const audio = fieldNamed(inputs, "audio");
  return {
    resolution: fieldNamed(inputs, "resolution"),
    mode: fieldNamed(inputs, "mode"),
    audio: generateAudio
      ? { name: "generate_audio", field: generateAudio }
      : audio
        ? { name: "audio", field: audio }
        : null,
    negativePrompt: fieldNamed(inputs, "negative_prompt"),
    seed: fieldNamed(inputs, "seed"),
    characterOrientation: fieldNamed(inputs, "character_orientation"),
    keepOriginalSound: fieldNamed(inputs, "keep_original_sound"),
  };
}

export function hasAnyReplicateTweaks(fields: ReplicateTweakFields): boolean {
  return Boolean(
    fields.resolution ||
      fields.mode ||
      fields.audio ||
      fields.negativePrompt ||
      fields.seed ||
      fields.characterOrientation ||
      fields.keepOriginalSound,
  );
}

function enumValues(field: ReplicateInputField | null): string[] {
  if (!field?.enumValues?.length) return [];
  return field.enumValues.map((v) => String(v).trim()).filter(Boolean);
}

function defaultEnumValue(field: ReplicateInputField | null): string | undefined {
  const values = enumValues(field);
  if (values.length === 0) return undefined;
  const def = field?.defaultValue;
  if (def != null && values.includes(String(def))) return String(def);
  // Prefer mid quality defaults when present.
  for (const prefer of ["1080p", "720p", "pro", "std", "standard"]) {
    if (values.includes(prefer)) return prefer;
  }
  return values[0];
}

/**
 * Coerce draft tweaks to values valid for the current model.
 * Timeline default: generateAudio = false when the field exists.
 */
export function normalizeReplicateTweaks(
  fields: ReplicateTweakFields,
  draft: ReplicateVideoTweaks | null | undefined,
): ReplicateVideoTweaks {
  const next: ReplicateVideoTweaks = {};

  if (fields.resolution) {
    const values = enumValues(fields.resolution);
    const pref = draft?.resolution?.trim();
    next.resolution =
      pref && values.includes(pref)
        ? pref
        : defaultEnumValue(fields.resolution);
  }

  if (fields.mode) {
    const values = enumValues(fields.mode);
    const pref = draft?.mode?.trim();
    next.mode =
      pref && values.includes(pref) ? pref : defaultEnumValue(fields.mode);
  }

  if (fields.audio) {
    next.generateAudio =
      typeof draft?.generateAudio === "boolean" ? draft.generateAudio : false;
  }

  if (fields.negativePrompt) {
    next.negativePrompt =
      typeof draft?.negativePrompt === "string" ? draft.negativePrompt : "";
  }

  if (fields.seed) {
    if (
      typeof draft?.seed === "number" &&
      Number.isFinite(draft.seed) &&
      draft.seed >= 0
    ) {
      next.seed = Math.floor(draft.seed);
    } else {
      next.seed = null;
    }
  }

  if (fields.characterOrientation) {
    const values = enumValues(fields.characterOrientation);
    const pref = draft?.characterOrientation?.trim();
    next.characterOrientation =
      pref && values.includes(pref)
        ? pref
        : defaultEnumValue(fields.characterOrientation);
  }

  if (fields.keepOriginalSound) {
    next.keepOriginalSound =
      typeof draft?.keepOriginalSound === "boolean"
        ? draft.keepOriginalSound
        : true;
  }

  return next;
}

/** Merge tweak values into the Replicate predict input object. */
export function applyReplicateTweaksToInput(
  input: Record<string, unknown>,
  fields: ReplicateTweakFields,
  tweaks: ReplicateVideoTweaks,
): void {
  if (fields.resolution && tweaks.resolution) {
    input.resolution = tweaks.resolution;
  }
  if (fields.mode && tweaks.mode) {
    input.mode = tweaks.mode;
  }
  if (fields.audio && typeof tweaks.generateAudio === "boolean") {
    input[fields.audio.name] = tweaks.generateAudio;
  }
  if (fields.negativePrompt) {
    const text = tweaks.negativePrompt?.trim() ?? "";
    if (text) input.negative_prompt = text;
  }
  if (
    fields.seed &&
    typeof tweaks.seed === "number" &&
    Number.isFinite(tweaks.seed)
  ) {
    input.seed = Math.floor(tweaks.seed);
  }
  if (fields.characterOrientation && tweaks.characterOrientation) {
    input.character_orientation = tweaks.characterOrientation;
  }
  if (
    fields.keepOriginalSound &&
    typeof tweaks.keepOriginalSound === "boolean"
  ) {
    input.keep_original_sound = tweaks.keepOriginalSound;
  }
}

export function replicateTweaksEqual(
  a: ReplicateVideoTweaks | null | undefined,
  b: ReplicateVideoTweaks | null | undefined,
): boolean {
  const aa = a ?? {};
  const bb = b ?? {};
  return (
    (aa.resolution ?? "") === (bb.resolution ?? "") &&
    (aa.mode ?? "") === (bb.mode ?? "") &&
    Boolean(aa.generateAudio) === Boolean(bb.generateAudio) &&
    (aa.negativePrompt ?? "") === (bb.negativePrompt ?? "") &&
    (aa.seed ?? null) === (bb.seed ?? null) &&
    (aa.characterOrientation ?? "") === (bb.characterOrientation ?? "") &&
    (aa.keepOriginalSound ?? true) === (bb.keepOriginalSound ?? true)
  );
}

/** Parse a loosely typed draft blob into tweaks (project load). */
export function parseReplicateVideoTweaks(
  value: unknown,
): ReplicateVideoTweaks | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const out: ReplicateVideoTweaks = {};
  if (typeof row.resolution === "string" && row.resolution.trim()) {
    out.resolution = row.resolution.trim();
  }
  if (typeof row.mode === "string" && row.mode.trim()) {
    out.mode = row.mode.trim();
  }
  if (typeof row.generateAudio === "boolean") {
    out.generateAudio = row.generateAudio;
  }
  if (typeof row.negativePrompt === "string") {
    out.negativePrompt = row.negativePrompt;
  }
  if (typeof row.seed === "number" && Number.isFinite(row.seed)) {
    out.seed = Math.floor(row.seed);
  } else if (row.seed === null) {
    out.seed = null;
  }
  if (
    typeof row.characterOrientation === "string" &&
    row.characterOrientation.trim()
  ) {
    out.characterOrientation = row.characterOrientation.trim();
  }
  if (typeof row.keepOriginalSound === "boolean") {
    out.keepOriginalSound = row.keepOriginalSound;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
