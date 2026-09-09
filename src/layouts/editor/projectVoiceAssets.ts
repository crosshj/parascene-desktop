import { addAssetGenerationFromCreation } from "../../project/desktopAddAssetGeneration";
import type { Creation } from "../../library/types";

export type ProjectVoiceOption = {
  creationId: string;
  voiceId: string;
  label: string;
};

export function voiceIdFromCreation(
  creation: Pick<Creation, "remoteJson" | "mediaType"> | null | undefined,
): string | null {
  if (!creation) return null;
  if (String(creation.mediaType ?? "").trim().toLowerCase() !== "audio") {
    return null;
  }
  const voiceId = addAssetGenerationFromCreation(creation)?.voiceId?.trim();
  return voiceId || null;
}

export function projectVoiceOptions(
  creations: readonly Creation[],
): ProjectVoiceOption[] {
  const out: ProjectVoiceOption[] = [];
  for (const creation of creations) {
    const voiceId = voiceIdFromCreation(creation);
    if (!voiceId) continue;
    out.push({
      creationId: creation.id,
      voiceId,
      label: creation.title?.trim() || voiceId,
    });
  }
  return out;
}
