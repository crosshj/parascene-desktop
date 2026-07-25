import { createAuthedSdk } from "../auth/session";
import type { RemoteCreateImage } from "../sdk/parascene";
import { ingestRemoteCreation, newCreationToken } from "./ingestCreation";

export const FLF2V_MODEL = "wan_i2v";

export type Flf2vCreateArgs = {
  prompt: string;
  model: typeof FLF2V_MODEL;
  aspect_ratio: string;
  input_images: [string, string];
  duration_seconds?: number;
};

/** Pure builder for WAN first/last-frame image2video create args. */
export function buildFlf2vCreateArgs(opts: {
  prompt: string;
  aspectRatio: string;
  firstImageUrl: string;
  lastImageUrl: string;
  durationSeconds?: number;
}): Flf2vCreateArgs {
  const args: Flf2vCreateArgs = {
    prompt: opts.prompt.trim(),
    model: FLF2V_MODEL,
    aspect_ratio: opts.aspectRatio,
    input_images: [opts.firstImageUrl, opts.lastImageUrl],
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

export type RunFlf2vGenerationOpts = {
  prompt: string;
  aspectRatio: string;
  firstImageUrl: string;
  lastImageUrl: string;
  /** Output length in seconds. Caller must clamp. */
  durationSeconds?: number;
  onProgress: (note: string) => void;
  onPendingCreation?: (id: string | null) => void;
};

export async function runFlf2vGeneration(
  opts: RunFlf2vGenerationOpts,
): Promise<{ creationId: string; remote: RemoteCreateImage }> {
  const {
    prompt,
    aspectRatio,
    firstImageUrl,
    lastImageUrl,
    durationSeconds,
    onProgress,
    onPendingCreation,
  } = opts;
  onProgress("Starting first–last frame video…");
  const sdk = createAuthedSdk();
  const args = buildFlf2vCreateArgs({
    prompt,
    aspectRatio,
    firstImageUrl,
    lastImageUrl,
    durationSeconds,
  });
  const started = await sdk.create({
    serverId: 6,
    method: "image2video",
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
