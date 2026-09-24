export const WAN_T2V_MODEL = "wan_t2v";
export const LTX_T2V_MODEL = "ltx_t2v";

/** Capability-advertised text2video model id. */
export type BlueT2vModel = string;

export type BlueT2vCreateArgs = {
  prompt: string;
  model: BlueT2vModel;
  aspect_ratio: string;
  duration_seconds?: number;
};

/** Pure builder for Parascene Blue text2video create args. */
export function buildBlueT2vCreateArgs(opts: {
  prompt: string;
  aspectRatio: string;
  model: BlueT2vModel;
  durationSeconds?: number;
}): BlueT2vCreateArgs {
  const args: BlueT2vCreateArgs = {
    prompt: opts.prompt.trim(),
    model: opts.model,
    aspect_ratio: opts.aspectRatio,
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
