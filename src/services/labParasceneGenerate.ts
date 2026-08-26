/**
 * Lab Parascene create → wait → file via service_invoke.
 * UI paints progress; Rust owns the loop.
 */
import {
  invokeParasceneGenerate,
  pendingCreationIdFromRun,
  watchParasceneGenerate,
  type ParasceneGenerateResult,
} from "./generateStill";

export type LabParasceneGenerateOpts = {
  projectId: string;
  projectTitle: string;
  imagesGroupId?: string | null;
  videosGroupId?: string | null;
  serverId: number;
  method: string;
  args: Record<string, unknown>;
  mediaType: "image" | "video";
  intent?: string;
  mutateOfId?: number;
  label?: string;
  onProgress?: (note: string) => void;
  onPendingCreation?: (
    id: string | null,
    mediaType: "image" | "video" | null,
  ) => void;
};

export async function runLabParasceneGenerate(
  opts: LabParasceneGenerateOpts,
): Promise<ParasceneGenerateResult & { groupId: string | null }> {
  const intent =
    opts.intent ??
    (opts.mediaType === "video" ? "image_to_video" : "text_to_image");
  opts.onProgress?.(
    opts.mediaType === "video"
      ? "Starting video generation…"
      : "Starting image generation…",
  );
  const handle = await invokeParasceneGenerate({
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
    serverId: opts.serverId,
    method: opts.method,
    args: opts.args,
    intent,
    mediaType: opts.mediaType,
    target: "assets",
    label: opts.label ?? opts.method,
    mutateOfId: opts.mutateOfId,
  });

  const result = await watchParasceneGenerate(handle, {
    onUpdate: (run) => {
      const note = run.progressNote?.trim();
      if (note) opts.onProgress?.(note);
      const pendingId = pendingCreationIdFromRun(run);
      if (pendingId) {
        opts.onPendingCreation?.(pendingId, opts.mediaType);
      }
    },
  });
  opts.onPendingCreation?.(null, null);

  const groupId =
    opts.mediaType === "video"
      ? result.videosGroupId
      : result.imagesGroupId;

  return { ...result, groupId };
}
