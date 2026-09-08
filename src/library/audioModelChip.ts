import { addAssetGenerationFromCreation } from "../project/desktopAddAssetGeneration";
import type { Creation } from "./types";

export type AudioModelChipLabel = "LYRIA" | "FLASH" | "MM SPEECH";

export function audioModelChipClass(
  label: AudioModelChipLabel,
): "lyria" | "flash" | "mm-speech" {
  if (label === "LYRIA") return "lyria";
  if (label === "FLASH") return "flash";
  return "mm-speech";
}

/** Short board label for curated speech / music models. */
export function audioModelChipLabel(
  model: string | null | undefined,
): AudioModelChipLabel | null {
  const needle = model?.trim().toLowerCase() ?? "";
  if (!needle) return null;
  if (/lyria/.test(needle)) return "LYRIA";
  if (/flash/.test(needle)) return "FLASH";
  if (/clon/.test(needle) || /music/.test(needle)) return null;
  if (/speech-2\.8/.test(needle)) return "MM SPEECH";
  if (/minimax/.test(needle) && /speech/.test(needle)) return "MM SPEECH";
  return null;
}

export function audioModelChipFromCreation(
  creation: Pick<Creation, "remoteJson" | "mediaType"> | null | undefined,
): AudioModelChipLabel | null {
  const kind = String(creation?.mediaType ?? "")
    .trim()
    .toLowerCase();
  if (kind && kind !== "audio") return null;
  return audioModelChipLabel(
    addAssetGenerationFromCreation(creation)?.model,
  );
}

export function audioModelChipFromClip(
  clip: {
    kind?: string;
    lane?: string;
    addAssetGeneration?: { model?: string } | null;
  } | null | undefined,
): AudioModelChipLabel | null {
  if (!clip) return null;
  if (clip.lane !== "audio" && clip.kind !== "audio") return null;
  return audioModelChipLabel(clip.addAssetGeneration?.model);
}
