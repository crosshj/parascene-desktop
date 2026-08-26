export const LTX_I2V_MODEL = "ltx_i2v";

export type LtxI2vCreateArgs = {
  prompt: string;
  model: typeof LTX_I2V_MODEL;
  aspect_ratio: string;
  input_images: [string];
  duration_seconds?: number;
};

/** Pure builder for LTX image2video create args. */
export function buildLtxI2vCreateArgs(opts: {
  prompt: string;
  aspectRatio: string;
  imageUrl: string;
  durationSeconds?: number;
}): LtxI2vCreateArgs {
  const args: LtxI2vCreateArgs = {
    prompt: opts.prompt.trim(),
    model: LTX_I2V_MODEL,
    aspect_ratio: opts.aspectRatio,
    input_images: [opts.imageUrl],
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
