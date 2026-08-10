/**
 * Pure helpers for Replicate OpenAPI input schema → Lab run form / payload.
 */

import {
  aspectChooserOptionsFromSupported,
  pickAspectChooserValue,
} from "../../project/aspectRatios";
import type { ReplicateInputField } from "../../replicate/replicateClient";

export type FileFieldKind = "image" | "audio" | "video" | "any";

export function fieldBlob(field: ReplicateInputField): string {
  return `${field.name} ${field.title ?? ""} ${field.description ?? ""}`.toLowerCase();
}

export function fileFieldKind(field: ReplicateInputField): FileFieldKind {
  const blob = fieldBlob(field);
  if (blob.includes("audio")) return "audio";
  if (blob.includes("video")) return "video";
  if (
    blob.includes("image") ||
    blob.includes("mask") ||
    blob.includes("photo") ||
    blob.includes("picture")
  ) {
    return "image";
  }
  return "any";
}

export function fileFieldLabel(kind: FileFieldKind): string {
  switch (kind) {
    case "image":
      return "uri / image";
    case "audio":
      return "uri / audio";
    case "video":
      return "uri / video";
    default:
      return "uri / file";
  }
}

export function formatRunError(message: string): string {
  const jsonStart = message.indexOf("{");
  if (jsonStart === -1) return message;
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as unknown;
    const prefix = message.slice(0, jsonStart).trim();
    const body = JSON.stringify(parsed, null, 2);
    return prefix ? `${prefix}\n${body}` : body;
  } catch {
    return message;
  }
}

/** All schema fields including file-like URI inputs (image / audio / video). */
export function runnableFields(inputs: ReplicateInputField[]): ReplicateInputField[] {
  return inputs;
}

export function isFileField(field: ReplicateInputField): boolean {
  if (field.fileLike) return true;
  // Stale catalog / schemas that omit format:uri but still want a media URL.
  if (field.typeName !== "string") return false;
  if (field.enumValues?.length) return false;
  return looksLikeMediaUrlField(field);
}

export function looksLikeMediaUrlField(field: ReplicateInputField): boolean {
  const n = field.name.toLowerCase();
  const blob = fieldBlob(field);
  const urlish =
    n.endsWith("_url") ||
    n.endsWith("_uri") ||
    n.endsWith("_file") ||
    n === "url" ||
    n === "uri" ||
    n === "audio" ||
    n === "video" ||
    n === "image" ||
    blob.includes("publicly accessible") ||
    blob.includes("http") ||
    (field.title ?? "").toLowerCase().includes("url");
  const media =
    blob.includes("audio") ||
    blob.includes("video") ||
    blob.includes("image") ||
    blob.includes("song") ||
    blob.includes("music") ||
    blob.includes("mp3") ||
    blob.includes("wav") ||
    blob.includes("mask") ||
    blob.includes("photo") ||
    blob.includes("picture");
  return urlish && media;
}

export function isFileArrayField(field: ReplicateInputField): boolean {
  if (field.arrayItemFileLike) return true;
  // Stale catalog detail may lack arrayItemFileLike until Update model.
  if (field.typeName !== "array") return false;
  const blob = fieldBlob(field);
  return (
    blob.includes("image") ||
    blob.includes("audio") ||
    blob.includes("video") ||
    blob.includes("file")
  );
}

export function isAnyFileField(field: ReplicateInputField): boolean {
  return isFileField(field) || isFileArrayField(field);
}

export function formatDefaultLabel(field: ReplicateInputField): string | null {
  if (field.defaultValue === null || field.defaultValue === undefined) return null;
  if (typeof field.defaultValue === "boolean") {
    return field.defaultValue ? "true" : "false";
  }
  return String(field.defaultValue);
}

export function isAspectRatioField(field: ReplicateInputField): boolean {
  const n = field.name.toLowerCase().replace(/-/g, "_");
  return n === "aspect_ratio" || n === "aspectratio";
}

export function aspectChooserOptionsForField(field: ReplicateInputField) {
  if (!isAspectRatioField(field)) return [];
  return aspectChooserOptionsFromSupported(field.enumValues);
}

export function defaultFormValue(field: ReplicateInputField): string {
  const aspectOpts = aspectChooserOptionsForField(field);
  if (aspectOpts.length > 0) {
    const preferred =
      field.defaultValue === null || field.defaultValue === undefined
        ? ""
        : String(field.defaultValue);
    return pickAspectChooserValue(aspectOpts, preferred);
  }
  const d = field.defaultValue;
  if (d === null || d === undefined) {
    if (field.typeName === "boolean") return "false";
    // Required enums with no schema default: pick the first option so the
    // controlled <select> isn't stuck on a blank value.
    if (field.required && field.enumValues?.length) {
      return field.enumValues[0] ?? "";
    }
    return "";
  }
  if (typeof d === "boolean") return d ? "true" : "false";
  if (typeof d === "number" && Number.isFinite(d)) return String(d);
  return String(d);
}

/** Prefer stored value; if blank, fall back to schema / first-option default. */
export function resolveFormValue(
  field: ReplicateInputField,
  values: Record<string, string>,
): string {
  const raw = values[field.name];
  if (raw !== undefined && raw.trim() !== "") return raw;
  return defaultFormValue(field);
}

/** Slider when OpenAPI provides a finite, usable min/max (skip huge ranges like seed). */
export function hasSliderRange(field: ReplicateInputField): boolean {
  const min = field.minimum;
  const max = field.maximum;
  if (min == null || max == null || !(max > min)) return false;
  const span = max - min;
  if (field.typeName === "integer") return span <= 10_000;
  return span <= 10_000;
}

export function sliderStep(field: ReplicateInputField): number {
  if (field.typeName === "integer") return 1;
  const min = field.minimum ?? 0;
  const max = field.maximum ?? 1;
  const span = Math.max(0.0001, max - min);
  if (span <= 1) return 0.01;
  if (span <= 20) return 0.1;
  return 1;
}

export function clampNumericString(
  raw: string,
  field: ReplicateInputField,
): string {
  if (!raw.trim()) return raw;
  const n =
    field.typeName === "integer"
      ? Number.parseInt(raw, 10)
      : Number(raw);
  if (!Number.isFinite(n)) return raw;
  let v = n;
  if (field.minimum != null) v = Math.max(field.minimum, v);
  if (field.maximum != null) v = Math.min(field.maximum, v);
  if (field.typeName === "integer") return String(Math.round(v));
  return String(v);
}

function isIntegerEnumField(field: ReplicateInputField): boolean {
  const enums = field.enumValues;
  if (!enums?.length) return false;
  return enums.every((v) => /^-?\d+$/.test(v.trim()));
}

function isNumberEnumField(field: ReplicateInputField): boolean {
  const enums = field.enumValues;
  if (!enums?.length) return false;
  return enums.every((v) => Number.isFinite(Number(v)));
}

export function buildRunInput(
  fields: ReplicateInputField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const aspectOpts = aspectChooserOptionsForField(field);
    const raw =
      aspectOpts.length > 0
        ? pickAspectChooserValue(aspectOpts, values[field.name])
        : resolveFormValue(field, values);
    const trimmed = raw.trim();
    if (!trimmed && !field.required) continue;
    const typeName =
      field.typeName === "integer" || isIntegerEnumField(field)
        ? "integer"
        : field.typeName === "number" || isNumberEnumField(field)
          ? "number"
          : field.typeName;
    switch (typeName) {
      case "integer": {
        const n = Number.parseInt(trimmed, 10);
        if (Number.isFinite(n)) out[field.name] = n;
        break;
      }
      case "number": {
        const n = Number(trimmed);
        if (Number.isFinite(n)) out[field.name] = n;
        break;
      }
      case "boolean":
        out[field.name] = trimmed === "true" || trimmed === "1";
        break;
      default:
        if (trimmed) out[field.name] = trimmed;
        break;
    }
  }
  return out;
}
