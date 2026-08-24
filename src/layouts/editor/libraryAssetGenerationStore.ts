/**
 * In-flight Generate → Assets jobs keyed by project placeholder id.
 * Survives leaving the + slot — UI reads {@link LibraryAssetPlaceholder} on the project.
 */

import type { ProjectAspectRatio } from "../../project/aspectRatios";
import type { CreationTarget } from "../../services/types";
import type { AddAssetDraft, AddAssetGeneration } from "../../project/types";
import type { AddAssetGenerationJob } from "../../project/types";
import { applyManifest, getCreation } from "../../library/catalogClient";
import {
  creationUpsertWithAddAssetGeneration,
  makeTextToImageGeneration,
} from "../../project/desktopAddAssetGeneration";
import {
  invokeBlueGenerateStill,
  invokeParasceneGenerateStill,
  invokeReplicateGenerateStill,
  pendingCreationIdFromRun,
  watchLocalGenerateStill,
  watchParasceneGenerateStill,
} from "../../services/generateStill";
import type { ServiceRun } from "../../services/types";
import {
  parasceneResolveStillModel,
  parasceneStillModelFamilies,
  type ParasceneStillModelOption,
} from "./parasceneProductCaps";
import { runParasceneImageToImage } from "./runParasceneImageToImage";
import {
  loadReplicateTextToImageModels,
  type ReplicateTextToImageModelOption,
} from "./replicateTextToImageModels";
import { buildReplicateTextToImageInput } from "./textToImageInput";
import {
  makeLibraryAssetPlaceholderDraft,
  newLibraryAssetPlaceholderId,
} from "./libraryAssetGeneration";
import type { LibraryAssetPlaceholder } from "../../project/libraryAssetPlaceholder";

export type StartLibraryParasceneTextToImageOpts = {
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  aspectRatio: ProjectAspectRatio;
  prompt: string;
  modelId: string;
  route: ParasceneStillModelOption;
  destination?: CreationTarget;
  /** When omitted, a new placeholder id is reserved. */
  placeholderId?: string;
  onPlaceholderReserved?: (assetId: string) => void;
};

type LibraryAssetGenerationApplier = {
  beginPlaceholder: (opts: {
    id: string;
    aspectRatio: ProjectAspectRatio;
    draft: ReturnType<typeof makeLibraryAssetPlaceholderDraft>;
  }) => void;
  /** Select the new placeholder when generation starts. */
  onGenerationStarted: (placeholderId: string) => void;
  patchPlaceholder: (
    id: string,
    patch: {
      status?: "generating" | "done" | "error";
      progressNote?: string;
      addAssetDraft?: Partial<AddAssetDraft>;
    },
  ) => void;
  completePlaceholder: (opts: {
    placeholderId: string;
    creationId: string;
  }) => void;
  addCreations: (creationIds: string[]) => Promise<void>;
  setImagesGroupId: (imagesGroupId: string) => void;
  placeTimelineClip?: (opts: { creationId: string; label: string }) => void;
};

let applier: LibraryAssetGenerationApplier | null = null;
const inflight = new Set<string>();

export function bindLibraryAssetGenerationApplier(
  next: LibraryAssetGenerationApplier | null,
): void {
  applier = next;
}

export function isLibraryAssetGenerationInflight(id: string): boolean {
  return inflight.has(id.trim());
}

export type RetryLibraryAssetPlaceholderOpts = {
  placeholder: LibraryAssetPlaceholder;
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
};

/** Re-run a failed Generate → Assets job on the same placeholder id. */
export async function retryLibraryAssetPlaceholder(
  opts: RetryLibraryAssetPlaceholderOpts,
): Promise<string | null> {
  const { placeholder } = opts;
  const prompt = placeholder.addAssetDraft.prompt?.trim() ?? "";
  if (!prompt) return null;

  const modelStored = placeholder.addAssetDraft.replicateModel?.trim() ?? "";
  const intentId = placeholder.addAssetDraft.intentId?.trim() ?? "text_to_image";
  const server = placeholder.addAssetDraft.server?.trim() ?? "parascene_blue";
  const base = {
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
    aspectRatio: placeholder.aspectRatio,
    prompt,
    placeholderId: placeholder.id,
  };

  if (intentId === "image_to_image") {
    const sourceCreationId = placeholder.addAssetDraft.startFrameAssetId?.trim();
    if (!sourceCreationId) return null;
    const route = resolveStillRoute("image_to_image", modelStored);
    if (!route) return null;
    return startLibraryParasceneImageToImage({
      ...base,
      modelId: route.id,
      route,
      sourceCreationId,
    });
  }

  if (server === "replicate") {
    const models = await loadReplicateTextToImageModels();
    const model =
      models.find((m) => m.id === modelStored) ??
      models.find((m) => m.id === modelStored.replace(/^replicate:/, "")) ??
      null;
    if (!model) return null;
    return startLibraryReplicateTextToImage({ ...base, model });
  }

  if (server === "blue_direct") {
    const modelId = modelStored.trim();
    if (!modelId) return null;
    return startLibraryBlueDirectTextToImage({ ...base, modelId });
  }

  const route = resolveStillRoute("text_to_image", modelStored);
  if (!route) return null;
  return startLibraryParasceneTextToImage({
    ...base,
    modelId: route.id,
    route,
  });
}

function resolveStillRoute(
  intentId: "text_to_image" | "image_to_image",
  modelStored: string,
): ParasceneStillModelOption | null {
  if (modelStored) {
    const hit = parasceneResolveStillModel(intentId, modelStored);
    if (hit) return hit;
  }
  const models = parasceneStillModelFamilies(intentId).flatMap(
    (group) => group.models,
  );
  return models[0] ?? null;
}

export function startLibraryParasceneTextToImage(
  opts: StartLibraryParasceneTextToImageOpts,
): string {
  if (!applier) {
    throw new Error("Library asset generation is not ready.");
  }
  const placeholderId = opts.placeholderId?.trim() || newLibraryAssetPlaceholderId();
  if (inflight.has(placeholderId)) return placeholderId;

  const startedAt = new Date().toISOString();
  const destination = opts.destination ?? "assets";
  const draft = makeLibraryAssetPlaceholderDraft({
    prompt: opts.prompt,
    intentId: "text_to_image",
    server: "parascene_blue",
    provider: "parascene_blue",
    model: opts.route.value,
  });

  applier.beginPlaceholder({
    id: placeholderId,
    aspectRatio: opts.aspectRatio,
    draft: {
      ...draft,
      generateDestination: destination,
      generationJob: {
        status: "starting",
        provider: "parascene_blue",
        startedAt,
        model: opts.route.value,
      },
    },
  });
  applier.onGenerationStarted(placeholderId);
  opts.onPlaceholderReserved?.(placeholderId);

  inflight.add(placeholderId);
  void runLibraryParasceneTextToImage({
    ...opts,
    placeholderId,
    startedAt,
  }).finally(() => {
    inflight.delete(placeholderId);
  });

  return placeholderId;
}

async function runLibraryParasceneTextToImage(
  opts: StartLibraryParasceneTextToImageOpts & {
    placeholderId: string;
    startedAt: string;
  },
): Promise<void> {
  if (!applier) return;
  const { placeholderId, startedAt } = opts;
  const destination = opts.destination ?? "assets";
  let pendingCreationId: string | undefined;

  const patchJob = (
    note: string,
    status: AddAssetGenerationJob["status"],
  ) => {
    applier?.patchPlaceholder(placeholderId, {
      status: "generating",
      progressNote: note,
      addAssetDraft: {
        generationJob: {
          status,
          provider: "parascene_blue",
          startedAt,
          pendingCreationId,
          model: opts.route.value,
        },
      },
    });
  };

  try {
    patchJob("Starting image generation on Parascene…", "starting");
    const args: Record<string, unknown> = {
      prompt: opts.prompt.trim(),
      model: opts.route.value,
    };
    if (opts.route.method !== "pixelLabImage") {
      args.aspect_ratio = opts.aspectRatio;
    }

    const handle = await invokeParasceneGenerateStill({
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
      imagesGroupId: opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
      serverId: opts.route.serverId,
      method: opts.route.method,
      args,
      target: destination,
      clientRequestId: placeholderId,
      label: opts.route.label || opts.route.method,
    });

    const applyRun = (run: ServiceRun) => {
      const note = run.progressNote?.trim() || "Working…";
      const id = pendingCreationIdFromRun(run);
      if (id) pendingCreationId = id;
      const lower = note.toLowerCase();
      const status: AddAssetGenerationJob["status"] = lower.includes("filing")
        || lower.includes("syncing")
        ? "importing"
        : String(run.status) === "waiting"
          ? "waiting"
          : String(run.status) === "queued"
            ? "starting"
            : "waiting";
      patchJob(note, status);
    };

    const result = await watchParasceneGenerateStill(handle, {
      onUpdate: applyRun,
    });

    await finishLibraryTextToImagePlaceholder({
      placeholderId,
      creationId: result.creationId,
      prompt: opts.prompt,
      destination,
      projectCreationIds: result.projectCreationIds,
      imagesGroupId: result.imagesGroupId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    applier.patchPlaceholder(placeholderId, {
      status: "error",
      progressNote: message,
      addAssetDraft: {
        lastError: message,
        generationJob: undefined,
      },
    });
  }
}

export type StartLibraryReplicateTextToImageOpts = {
  projectId: string;
  aspectRatio: ProjectAspectRatio;
  prompt: string;
  model: ReplicateTextToImageModelOption;
  destination?: CreationTarget;
  placeholderId?: string;
  onPlaceholderReserved?: (assetId: string) => void;
};

export type StartLibraryBlueDirectTextToImageOpts = {
  projectId: string;
  aspectRatio: ProjectAspectRatio;
  prompt: string;
  modelId: string;
  destination?: CreationTarget;
  placeholderId?: string;
  onPlaceholderReserved?: (assetId: string) => void;
};

async function stampLocalTextToImageProvenance(opts: {
  creationId: string;
  prompt: string;
  model: string;
  server: "replicate" | "blue_direct";
}): Promise<void> {
  try {
    const creation = await getCreation(opts.creationId);
    await applyManifest([
      creationUpsertWithAddAssetGeneration(
        creation,
        makeTextToImageGeneration({
          prompt: opts.prompt,
          creationId: opts.creationId,
          model: opts.model,
          server: opts.server,
        }),
      ),
    ]);
  } catch {
    // Provenance stamp is best-effort.
  }
}

function beginLibraryTextToImagePlaceholder(opts: {
  placeholderId: string;
  aspectRatio: ProjectAspectRatio;
  prompt: string;
  server: string;
  provider: AddAssetGenerationJob["provider"];
  model: string;
  startedAt: string;
  destination: CreationTarget;
}): void {
  if (!applier) throw new Error("Library asset generation is not ready.");
  const draft = makeLibraryAssetPlaceholderDraft({
    prompt: opts.prompt,
    intentId: "text_to_image",
    server: opts.server,
    provider: opts.provider,
    model: opts.model,
  });
  applier.beginPlaceholder({
    id: opts.placeholderId,
    aspectRatio: opts.aspectRatio,
    draft: {
      ...draft,
      generateDestination: opts.destination,
      generationJob: {
        status: "starting",
        provider: opts.provider,
        startedAt: opts.startedAt,
        model: opts.model,
      },
    },
  });
  applier.onGenerationStarted(opts.placeholderId);
}

async function finishLibraryTextToImagePlaceholder(opts: {
  placeholderId: string;
  creationId: string;
  prompt: string;
  destination: CreationTarget;
  projectCreationIds?: string[];
  imagesGroupId?: string | null;
}): Promise<void> {
  if (!applier) return;
  if (opts.imagesGroupId) {
    applier.setImagesGroupId(opts.imagesGroupId);
  }
  const ids =
    opts.projectCreationIds && opts.projectCreationIds.length > 0
      ? opts.projectCreationIds
      : [opts.creationId];
  if (opts.destination === "timeline") {
    applier.placeTimelineClip?.({
      creationId: opts.creationId,
      label: opts.prompt.trim() || "Image",
    });
    await applier.addCreations(ids);
  } else {
    await applier.addCreations(ids);
  }
  applier.completePlaceholder({
    placeholderId: opts.placeholderId,
    creationId: opts.creationId,
  });
}

export function startLibraryReplicateTextToImage(
  opts: StartLibraryReplicateTextToImageOpts,
): string {
  if (!applier) {
    throw new Error("Library asset generation is not ready.");
  }
  const placeholderId = opts.placeholderId?.trim() || newLibraryAssetPlaceholderId();
  if (inflight.has(placeholderId)) return placeholderId;

  const startedAt = new Date().toISOString();
  const destination = opts.destination ?? "assets";
  beginLibraryTextToImagePlaceholder({
    placeholderId,
    aspectRatio: opts.aspectRatio,
    prompt: opts.prompt,
    server: "replicate",
    provider: "replicate",
    model: opts.model.id,
    startedAt,
    destination,
  });
  opts.onPlaceholderReserved?.(placeholderId);

  inflight.add(placeholderId);
  void runLibraryReplicateTextToImage({
    ...opts,
    placeholderId,
    startedAt,
  }).finally(() => {
    inflight.delete(placeholderId);
  });

  return placeholderId;
}

async function runLibraryReplicateTextToImage(
  opts: StartLibraryReplicateTextToImageOpts & {
    placeholderId: string;
    startedAt: string;
  },
): Promise<void> {
  if (!applier) return;
  const { placeholderId, startedAt } = opts;
  const destination = opts.destination ?? "assets";

  const patchJob = (note: string, status: AddAssetGenerationJob["status"]) => {
    applier?.patchPlaceholder(placeholderId, {
      status: "generating",
      progressNote: note,
      addAssetDraft: {
        generationJob: {
          status,
          provider: "replicate",
          startedAt,
          model: opts.model.id,
        },
      },
    });
  };

  try {
    patchJob(`Running ${opts.model.id}…`, "starting");
    const input = buildReplicateTextToImageInput({
      model: opts.model,
      prompt: opts.prompt,
      aspectRatio: opts.aspectRatio,
    });
    const handle = await invokeReplicateGenerateStill({
      owner: opts.model.owner,
      name: opts.model.name,
      input,
      localFiles: {},
      requiredFileFields: [],
      projectId: opts.projectId,
      target: destination,
      clientRequestId: placeholderId,
      label: opts.model.id,
    });
    const result = await watchLocalGenerateStill(handle, {
      onUpdate: (run) => {
        const note = run.progressNote?.trim();
        if (!note) return;
        const lower = note.toLowerCase();
        const status: AddAssetGenerationJob["status"] = lower.includes("import")
          ? "importing"
          : "waiting";
        patchJob(note, status);
      },
    });
    await stampLocalTextToImageProvenance({
      creationId: result.creationId,
      prompt: opts.prompt,
      model: opts.model.id,
      server: "replicate",
    });
    await finishLibraryTextToImagePlaceholder({
      placeholderId,
      creationId: result.creationId,
      prompt: opts.prompt,
      destination,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    applier.patchPlaceholder(placeholderId, {
      status: "error",
      progressNote: message,
      addAssetDraft: {
        lastError: message,
        generationJob: undefined,
      },
    });
  }
}

export function startLibraryBlueDirectTextToImage(
  opts: StartLibraryBlueDirectTextToImageOpts,
): string {
  if (!applier) {
    throw new Error("Library asset generation is not ready.");
  }
  const placeholderId = opts.placeholderId?.trim() || newLibraryAssetPlaceholderId();
  if (inflight.has(placeholderId)) return placeholderId;

  const startedAt = new Date().toISOString();
  const destination = opts.destination ?? "assets";
  beginLibraryTextToImagePlaceholder({
    placeholderId,
    aspectRatio: opts.aspectRatio,
    prompt: opts.prompt,
    server: "blue_direct",
    provider: "blue_direct",
    model: opts.modelId,
    startedAt,
    destination,
  });
  opts.onPlaceholderReserved?.(placeholderId);

  inflight.add(placeholderId);
  void runLibraryBlueDirectTextToImage({
    ...opts,
    placeholderId,
    startedAt,
  }).finally(() => {
    inflight.delete(placeholderId);
  });

  return placeholderId;
}

async function runLibraryBlueDirectTextToImage(
  opts: StartLibraryBlueDirectTextToImageOpts & {
    placeholderId: string;
    startedAt: string;
  },
): Promise<void> {
  if (!applier) return;
  const { placeholderId, startedAt } = opts;
  const destination = opts.destination ?? "assets";

  const patchJob = (note: string, status: AddAssetGenerationJob["status"]) => {
    applier?.patchPlaceholder(placeholderId, {
      status: "generating",
      progressNote: note,
      addAssetDraft: {
        generationJob: {
          status,
          provider: "blue_direct",
          startedAt,
          model: opts.modelId,
        },
      },
    });
  };

  try {
    patchJob("Running Text to Image on Direct to Blue…", "starting");
    const handle = await invokeBlueGenerateStill({
      method: "text2image",
      args: {
        prompt: opts.prompt.trim(),
        aspect_ratio: opts.aspectRatio,
        model: opts.modelId,
      },
      projectId: opts.projectId,
      target: destination,
      clientRequestId: placeholderId,
      label: opts.modelId,
    });
    const result = await watchLocalGenerateStill(handle, {
      onUpdate: (run) => {
        const note = run.progressNote?.trim();
        if (!note) return;
        const lower = note.toLowerCase();
        const status: AddAssetGenerationJob["status"] = lower.includes("import")
          ? "importing"
          : "waiting";
        patchJob(note, status);
      },
    });
    await stampLocalTextToImageProvenance({
      creationId: result.creationId,
      prompt: opts.prompt,
      model: opts.modelId,
      server: "blue_direct",
    });
    await finishLibraryTextToImagePlaceholder({
      placeholderId,
      creationId: result.creationId,
      prompt: opts.prompt,
      destination,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    applier.patchPlaceholder(placeholderId, {
      status: "error",
      progressNote: message,
      addAssetDraft: {
        lastError: message,
        generationJob: undefined,
      },
    });
  }
}


export type StartLibraryParasceneImageToImageOpts = {
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  aspectRatio: ProjectAspectRatio;
  prompt: string;
  modelId: string;
  route: ParasceneStillModelOption;
  sourceCreationId: string;
  /** When omitted, a new placeholder id is reserved. */
  placeholderId?: string;
  onPlaceholderReserved?: (assetId: string) => void;
};

export function startLibraryParasceneImageToImage(
  opts: StartLibraryParasceneImageToImageOpts,
): string {
  if (!applier) {
    throw new Error("Library asset generation is not ready.");
  }
  const placeholderId = opts.placeholderId?.trim() || newLibraryAssetPlaceholderId();
  if (inflight.has(placeholderId)) return placeholderId;

  const startedAt = new Date().toISOString();
  const draft = makeLibraryAssetPlaceholderDraft({
    prompt: opts.prompt,
    intentId: "image_to_image",
    server: "parascene_blue",
    provider: "parascene_blue",
    model: opts.route.value,
    startFrameAssetId: opts.sourceCreationId,
  });

  applier.beginPlaceholder({
    id: placeholderId,
    aspectRatio: opts.aspectRatio,
    draft: {
      ...draft,
      generationJob: {
        status: "starting",
        provider: "parascene_blue",
        startedAt,
        model: opts.route.value,
      },
    },
  });
  applier.onGenerationStarted(placeholderId);
  opts.onPlaceholderReserved?.(placeholderId);

  inflight.add(placeholderId);
  void runLibraryParasceneImageToImage({
    ...opts,
    placeholderId,
    startedAt,
  }).finally(() => {
    inflight.delete(placeholderId);
  });

  return placeholderId;
}

async function runLibraryParasceneImageToImage(
  opts: StartLibraryParasceneImageToImageOpts & {
    placeholderId: string;
    startedAt: string;
  },
): Promise<void> {
  if (!applier) return;
  const { placeholderId, startedAt } = opts;
  let pendingCreationId: string | undefined;

  const patchJob = (
    note: string,
    status: AddAssetGenerationJob["status"],
  ) => {
    applier?.patchPlaceholder(placeholderId, {
      status: "generating",
      progressNote: note,
      addAssetDraft: {
        generationJob: {
          status,
          provider: "parascene_blue",
          startedAt,
          pendingCreationId,
          model: opts.route.value,
        },
      },
    });
  };

  try {
    patchJob("Starting image-to-image on Parascene…", "starting");
    const result = await runParasceneImageToImage({
      prompt: opts.prompt,
      aspectRatio: opts.aspectRatio,
      modelId: opts.modelId,
      route: opts.route,
      sourceCreationId: opts.sourceCreationId,
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
      imagesGroupId: opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
      onProgress: (note) => {
        const lower = note.toLowerCase();
        const status: AddAssetGenerationJob["status"] = lower.includes(
          "syncing",
        )
          ? "importing"
          : lower.includes("filing")
            ? "importing"
            : "waiting";
        if (!pendingCreationId) {
          // Keep "starting" until we know a creation id when the runner reports early notes.
          patchJob(note, status === "waiting" ? "starting" : status);
          return;
        }
        patchJob(note, status);
      },
    });

    pendingCreationId = result.creationId;
    patchJob(`Syncing ${result.creationId}…`, "importing");

    if (result.imagesGroupId) {
      applier.setImagesGroupId(result.imagesGroupId);
    }
    if (result.projectCreationIds.length > 0) {
      await applier.addCreations(result.projectCreationIds);
    }

    // Parascene Creation meta is provenance — do not rewrite remoteJson.

    applier.completePlaceholder({
      placeholderId,
      creationId: result.creationId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    applier.patchPlaceholder(placeholderId, {
      status: "error",
      progressNote: message,
      addAssetDraft: {
        lastError: message,
        generationJob: undefined,
      },
    });
  }
}

export function libraryAssetGenerationFromPlaceholder(
  placeholder: {
    addAssetDraft: {
      prompt?: string;
      replicateModel?: string;
      server?: string;
    };
    addAssetGeneration?: AddAssetGeneration;
  } | null,
  creationId: string,
): AddAssetGeneration | null {
  if (placeholder?.addAssetGeneration) return placeholder.addAssetGeneration;
  const prompt = placeholder?.addAssetDraft.prompt?.trim();
  if (!placeholder || !prompt) return null;
  const serverRaw = placeholder.addAssetDraft.server?.trim();
  const server =
    serverRaw === "replicate" || serverRaw === "blue_direct"
      ? serverRaw
      : "parascene_blue";
  return makeTextToImageGeneration({
    prompt,
    creationId,
    model: placeholder.addAssetDraft.replicateModel ?? "",
    server,
  });
}
