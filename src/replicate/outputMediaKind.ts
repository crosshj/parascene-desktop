/** Classify local Replicate output paths by media kind. */

export type OutputMediaKind = "image" | "audio" | "video" | "other";

export function outputMediaKind(path: string): OutputMediaKind {
  const lower = path.toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(lower)) return "image";
  if (/\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/.test(lower)) return "audio";
  if (/\.(mp4|mov|mkv|avi|m4v|webm)$/.test(lower)) return "video";
  return "other";
}

export function isAudioPath(path: string): boolean {
  return outputMediaKind(path) === "audio";
}
