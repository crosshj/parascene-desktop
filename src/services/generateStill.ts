/**
 * Parascene / Blue / Replicate generate via service_invoke.
 * Stills and video share the same kernel; mediaType selects cabinet filing.
 */
import type { ReplicateRunResult } from "../replicate/replicateClient";
import {
  invokeBlueGenerate,
  invokeReplicateGenerate,
} from "./labGenerate";
import {
  serviceCancel,
  serviceInvoke,
  watchService,
  type WatchServiceOptions,
} from "./serviceClient";
import {
  checkpointFromRun,
  parseJsonBlob,
  type CreationTarget,
  type ServiceHandle,
  type ServiceRun,
} from "./types";

export type ParasceneGenerateResult = {
  creationId: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  projectCreationIds: string[];
  status?: string;
  target?: string;
  mediaType?: string;
};

/** @deprecated Prefer ParasceneGenerateResult */
export type ParasceneGenerateStillResult = ParasceneGenerateResult;

export type LocalGenerateStillResult = {
  creationId: string;
  localPaths: string[];
  predictionId?: string | null;
  status?: string;
  target?: string;
};

export type InvokeParasceneGenerateOpts = {
  projectId: string;
  projectTitle: string;
  imagesGroupId?: string | null;
  videosGroupId?: string | null;
  serverId: number;
  method: string;
  args: Record<string, unknown>;
  /** Defaults to text_to_image. */
  intent?: string;
  /** Defaults from intent (video intents → video). */
  mediaType?: "image" | "video";
  target?: CreationTarget;
  label?: string;
  clientRequestId?: string;
  creationToken?: string;
  /** Resume wait for a create that already exists instead of posting again. */
  pendingCreationId?: string;
  mutateOfId?: number;
};

/** @deprecated Prefer InvokeParasceneGenerateOpts */
export type InvokeParasceneGenerateStillOpts = InvokeParasceneGenerateOpts;

export type InvokeLocalGenerateStillOpts = {
  projectId: string;
  target?: CreationTarget;
  label?: string;
  clientRequestId?: string;
};

function resolveMediaType(
  opts: Pick<InvokeParasceneGenerateOpts, "intent" | "mediaType">,
): "image" | "video" {
  if (opts.mediaType === "image" || opts.mediaType === "video") {
    return opts.mediaType;
  }
  const intent = (opts.intent ?? "").toLowerCase();
  if (intent.includes("video")) return "video";
  return "image";
}

export async function invokeParasceneGenerate(
  opts: InvokeParasceneGenerateOpts,
): Promise<ServiceHandle> {
  const intent = opts.intent ?? "text_to_image";
  const mediaType = resolveMediaType({ intent, mediaType: opts.mediaType });
  return serviceInvoke({
    service: "parascene",
    operation: "generate",
    projectId: opts.projectId,
    target: opts.target ?? "assets",
    clientRequestId: opts.clientRequestId,
    label: opts.label ?? opts.method,
    payload: {
      intent,
      mediaType,
      serverId: opts.serverId,
      method: opts.method,
      args: opts.args,
      projectTitle: opts.projectTitle,
      ...(opts.imagesGroupId ? { imagesGroupId: opts.imagesGroupId } : {}),
      ...(opts.videosGroupId ? { videosGroupId: opts.videosGroupId } : {}),
      ...(opts.creationToken || opts.clientRequestId
        ? {
            creationToken: opts.creationToken ?? opts.clientRequestId,
          }
        : {}),
      ...(opts.pendingCreationId
        ? { pendingCreationId: opts.pendingCreationId }
        : {}),
      ...(typeof opts.mutateOfId === "number" && Number.isFinite(opts.mutateOfId)
        ? { mutateOfId: opts.mutateOfId }
        : {}),
    },
  });
}

/** @deprecated Prefer invokeParasceneGenerate */
export async function invokeParasceneGenerateStill(
  opts: InvokeParasceneGenerateStillOpts,
): Promise<ServiceHandle> {
  return invokeParasceneGenerate({
    ...opts,
    intent: opts.intent ?? "text_to_image",
    mediaType: opts.mediaType ?? "image",
  });
}

export async function invokeBlueGenerateStill(
  opts: InvokeLocalGenerateStillOpts & {
    method: string;
    args: Record<string, unknown>;
    localFiles?: Record<string, string | string[]>;
  },
): Promise<ServiceHandle> {
  return invokeBlueGenerate({
    method: opts.method,
    args: opts.args,
    localFiles: opts.localFiles,
    label: opts.label ?? opts.method,
    projectId: opts.projectId,
    target: opts.target ?? "assets",
    clientRequestId: opts.clientRequestId,
  });
}

export async function invokeReplicateGenerateStill(
  opts: InvokeLocalGenerateStillOpts & {
    owner: string;
    name: string;
    input: Record<string, unknown>;
    localFiles?: Record<string, string | string[]>;
    requiredFileFields?: string[];
  },
): Promise<ServiceHandle> {
  return invokeReplicateGenerate({
    owner: opts.owner,
    name: opts.name,
    input: opts.input,
    localFiles: opts.localFiles,
    requiredFileFields: opts.requiredFileFields,
    label: opts.label ?? `${opts.owner}/${opts.name}`,
    projectId: opts.projectId,
    target: opts.target ?? "assets",
    clientRequestId: opts.clientRequestId,
  });
}

export function parasceneResultFromRun(run: ServiceRun): ParasceneGenerateResult {
  const parsed = parseJsonBlob<ParasceneGenerateResult>(run.resultJson);
  const creationId = parsed?.creationId?.trim();
  if (!creationId) {
    throw new Error(run.error?.trim() || "Generate finished without a creation id");
  }
  return {
    creationId,
    imagesGroupId: parsed?.imagesGroupId?.trim() || null,
    videosGroupId: parsed?.videosGroupId?.trim() || null,
    projectCreationIds: Array.isArray(parsed?.projectCreationIds)
      ? parsed.projectCreationIds.filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        )
      : [],
    status: parsed?.status,
    target: parsed?.target,
    mediaType: parsed?.mediaType,
  };
}

/** @deprecated Prefer parasceneResultFromRun */
export function stillResultFromRun(run: ServiceRun): ParasceneGenerateStillResult {
  return parasceneResultFromRun(run);
}

export function localStillResultFromRun(run: ServiceRun): LocalGenerateStillResult {
  const parsed = parseJsonBlob<ReplicateRunResult & { creationId?: string }>(
    run.resultJson,
  );
  const creationId = parsed?.creationId?.trim();
  if (!creationId) {
    throw new Error(run.error?.trim() || "Generate finished without a creation id");
  }
  return {
    creationId,
    localPaths: Array.isArray(parsed?.localPaths)
      ? parsed.localPaths.filter(
          (p): p is string => typeof p === "string" && p.trim().length > 0,
        )
      : [],
    predictionId: parsed?.predictionId ?? null,
    status: parsed?.status,
  };
}

export function pendingCreationIdFromRun(run: ServiceRun): string | undefined {
  const cp = checkpointFromRun(run);
  const raw = cp?.pendingCreationId ?? cp?.creationId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export async function watchParasceneGenerate(
  handle: ServiceHandle,
  opts?: WatchServiceOptions,
): Promise<ParasceneGenerateResult> {
  const run = await watchService(handle, opts);
  if (String(run.status) === "cancelled") {
    throw new Error("Cancelled");
  }
  if (String(run.status) === "failed") {
    throw new Error(run.error?.trim() || "Generate failed");
  }
  return parasceneResultFromRun(run);
}

/** @deprecated Prefer watchParasceneGenerate */
export async function watchParasceneGenerateStill(
  handle: ServiceHandle,
  opts?: WatchServiceOptions,
): Promise<ParasceneGenerateStillResult> {
  return watchParasceneGenerate(handle, opts);
}

export async function watchLocalGenerateStill(
  handle: ServiceHandle,
  opts?: WatchServiceOptions,
): Promise<LocalGenerateStillResult> {
  const run = await watchService(handle, opts);
  if (String(run.status) === "cancelled") {
    throw new Error("Cancelled");
  }
  if (String(run.status) === "failed") {
    throw new Error(run.error?.trim() || "Generate failed");
  }
  return localStillResultFromRun(run);
}

export async function cancelGenerateStillJob(jobId: string): Promise<void> {
  await serviceCancel(jobId);
}

/** Resume: wait for an existing Parascene creation id via the service kernel. */
export async function invokeParasceneWaitCreation(opts: {
  creationId: string;
  projectId?: string;
  timeoutMs?: number;
  label?: string;
}): Promise<ServiceHandle> {
  return serviceInvoke({
    service: "parascene",
    operation: "wait_creation",
    projectId: opts.projectId,
    label: opts.label ?? `Wait ${opts.creationId}`,
    payload: {
      creationId: opts.creationId,
      ...(typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : {}),
    },
  });
}

export type WaitCreationResult = {
  creationId: string;
  status: string;
  creation: Record<string, unknown>;
};

export function waitCreationResultFromRun(run: ServiceRun): WaitCreationResult {
  const parsed = parseJsonBlob<{
    creationId?: string;
    status?: string;
    creation?: Record<string, unknown>;
  }>(run.resultJson);
  const creationId = parsed?.creationId?.trim();
  const creation = parsed?.creation;
  if (!creationId || !creation) {
    throw new Error(run.error?.trim() || "Wait finished without a creation");
  }
  return {
    creationId,
    status: (parsed?.status ?? "").toString(),
    creation,
  };
}

export async function watchParasceneWaitCreation(
  handle: ServiceHandle,
  opts?: WatchServiceOptions,
): Promise<WaitCreationResult> {
  const run = await watchService(handle, opts);
  if (String(run.status) === "cancelled") {
    throw new Error("Cancelled");
  }
  if (String(run.status) === "failed") {
    throw new Error(run.error?.trim() || "Wait failed");
  }
  return waitCreationResultFromRun(run);
}

export async function runParasceneWaitCreation(opts: {
  creationId: string;
  projectId?: string;
  timeoutMs?: number;
  onProgress?: (note: string) => void;
}): Promise<WaitCreationResult> {
  const handle = await invokeParasceneWaitCreation(opts);
  return watchParasceneWaitCreation(handle, {
    onUpdate: (run) => {
      const note = run.progressNote?.trim();
      if (note) opts.onProgress?.(note);
    },
  });
}
