import { createAuthedSdk } from "../auth/session";
import type { RemoteCreateImage } from "../sdk/parascene";
import { ingestRemoteCreation, newCreationToken } from "./ingestCreation";

export type RunA2vGenerationOpts = {
  prompt: string;
  aspectRatio: string;
  imageUrl: string;
  audioClipId: string;
  onProgress: (note: string) => void;
  onPendingCreation?: (id: string | null) => void;
};

export async function runA2vGeneration(
  opts: RunA2vGenerationOpts,
): Promise<{ creationId: string; remote: RemoteCreateImage }> {
  const { prompt, aspectRatio, imageUrl, audioClipId, onProgress, onPendingCreation } =
    opts;
  onProgress("Starting audio-to-video…");
  const sdk = createAuthedSdk();
  const started = await sdk.create({
    serverId: 6,
    method: "audio2video",
    creationToken: newCreationToken(),
    args: {
      prompt: prompt.trim(),
      model: "ltx_a2v",
      aspect_ratio: aspectRatio,
      input_images: [imageUrl],
      audio_clip_id: Number(audioClipId),
    },
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
