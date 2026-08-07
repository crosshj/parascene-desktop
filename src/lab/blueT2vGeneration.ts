import { createAuthedSdk } from "../auth/session";
import type { RemoteCreateImage } from "../sdk/parascene";
import { ingestRemoteCreation, newCreationToken } from "./ingestCreation";

export const WAN_T2V_MODEL = "wan_t2v";
export const LTX_T2V_MODEL = "ltx_t2v";

export type BlueT2vModel = typeof WAN_T2V_MODEL | typeof LTX_T2V_MODEL;

export type BlueT2vCreateArgs = {
  prompt: string;
  model: BlueT2vModel;
  aspect_ratio: string;
  duration_seconds?: number;
};

/** Pure builder for Parascene Blue text2video create args (WAN or LTX). */
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

export type RunBlueT2vGenerationOpts = {
  prompt: string;
  aspectRatio: string;
  /** WAN or LTX text-to-video model id. */
  model: BlueT2vModel;
  /** Output length in seconds. Caller must clamp. */
  durationSeconds?: number;
  onProgress: (note: string) => void;
  onPendingCreation?: (id: string | null) => void;
};

/** Parascene Blue text→video (`text2video` / wan_t2v|ltx_t2v) — no input images. */
export async function runBlueT2vGeneration(
  opts: RunBlueT2vGenerationOpts,
): Promise<{ creationId: string; remote: RemoteCreateImage }> {
  const {
    prompt,
    aspectRatio,
    model,
    durationSeconds,
    onProgress,
    onPendingCreation,
  } = opts;
  onProgress("Starting text-to-video…");
  const sdk = createAuthedSdk();
  const args = buildBlueT2vCreateArgs({
    prompt,
    aspectRatio,
    model,
    durationSeconds,
  });
  const started = await sdk.create({
    serverId: 6,
    method: "text2video",
    creationToken: newCreationToken(),
    args,
  });
  onPendingCreation?.(String(started.id));
  onProgress(`Generating video (${started.id})…`);
  const done = await sdk.waitForCreation(started.id, {
    onTick: (row) =>
      onProgress(`Generating video (${row.status || "…"})…`),
  });
  onPendingCreation?.(null);
  if (String(done.status).toLowerCase() === "failed") {
    throw new Error(`Video generation failed (${done.id})`);
  }
  onProgress("Syncing video to library…");
  const creationId = await ingestRemoteCreation(done);
  return { creationId, remote: done };
}
