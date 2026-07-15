export type StagedClipKind = "video" | "image" | "audio";

export function kindFromMediaType(mediaType: string): StagedClipKind {
  const mt = mediaType.trim().toLowerCase();
  if (mt === "video" || mt === "audio" || mt === "image") return mt;
  return "image";
}
