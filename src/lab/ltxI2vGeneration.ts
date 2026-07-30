import { createAuthedSdk } from "../auth/session";
import type { RemoteCreateImage } from "../sdk/parascene";
import { ingestRemoteCreation, newCreationToken } from "./ingestCreation";

export const LTX_I2V_MODEL = "ltx_i2v";

export type RunLtxI2vGenerationOpts = {
  prompt: string;
  aspectRatio: string;
  imageUrl: string;
  /** Output length in seconds. Caller must clamp. */
  durationSeconds?: number;
  onProgress: (note: string) => void;
  onPendingCreation?: (id: string | null) => void;
};

/** LTX image→video (no audio) for start-frame Blue fills with Source Audio = None. */
export async function runLtxI2vGeneration(
  opts: RunLtxI2vGenerationOpts,
): Promise<{ creationId: string; remote: RemoteCreateImage }> {
  const {
    prompt,
    aspectRatio,
    imageUrl,
    durationSeconds,
    onProgress,
    onPendingCreation,
  } = opts;
  onProgress("Starting image-to-video…");
  const sdk = createAuthedSdk();
  const args: Record<string, unknown> = {
    prompt: prompt.trim(),
    model: LTX_I2V_MODEL,
    aspect_ratio: aspectRatio,
    input_images: [imageUrl],
  };
  if (
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0
  ) {
    args.duration_seconds = durationSeconds;
  }
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
