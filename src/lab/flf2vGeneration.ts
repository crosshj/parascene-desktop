export const FLF2V_MODEL = "wan_i2v";

export type Flf2vCreateArgs = {
  prompt: string;
  model: typeof FLF2V_MODEL;
  aspect_ratio: string;
  input_images: [string] | [string, string];
  duration_seconds?: number;
};

/** Pure builder for WAN image2video create args (start-only or first+last). */
export function buildFlf2vCreateArgs(opts: {
  prompt: string;
  aspectRatio: string;
  firstImageUrl: string;
  lastImageUrl?: string;
  durationSeconds?: number;
}): Flf2vCreateArgs {
  const last = opts.lastImageUrl?.trim();
  const args: Flf2vCreateArgs = {
    prompt: opts.prompt.trim(),
    model: FLF2V_MODEL,
    aspect_ratio: opts.aspectRatio,
    input_images: last
      ? [opts.firstImageUrl, last]
      : [opts.firstImageUrl],
  };
  if (
    typeof opts.durationSeconds === "number" &&
    Number.isFinite(opts.durationSeconds) &&
    opts.durationSeconds > 0
  ) {
    args.duration_seconds = opts.durationSeconds;
  }
  return args;
}
