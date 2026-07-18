export type StagedClipKind = "video" | "image" | "audio" | "slideshow";

export function kindFromMediaType(mediaType: string): Exclude<StagedClipKind, "slideshow"> {
  const mt = mediaType.trim().toLowerCase();
  if (mt === "video" || mt === "audio" || mt === "image") return mt;
  return "image";
}
