/**
 * In-flight Generate → Assets jobs keyed by project placeholder id.
 * Survives leaving the + slot — UI reads {@link LibraryAssetPlaceholder} on the project.
 */

import type { ProjectAspectRatio } from "../../project/aspectRatios";
import type { CreationTarget } from "../../services/types";
import type { AddAssetDraft, AddAssetGeneration } from "../../project/types";
import type { AddAssetGenerationJob } from "../../project/types";
import { applyManifest, getCreation } from "../../library/catalogClient";
import { hasLocalMedia } from "../../library/previewUrl";
import {
  creationUpsertWithAddAssetGeneration,
  makeLibraryAudioGeneration,
  makeTextToImageGeneration,
} from "../../project/desktopAddAssetGeneration";
import { importLocalPathsForProject } from "../../project/projectAssetLanding";
import { sliceAudioRange } from "../../lab/audioTools";
import {
  cancelGenerateStillJob,
  invokeBlueGenerateStill,
  invokeParasceneGenerate,
  invokeParasceneGenerateStill,
  invokeReplicateGenerateStill,
  pendingCreationIdFromRun,
  predictionIdFromServiceRun,
  watchLocalGenerateStill,
  watchParasceneGenerate,
  watchParasceneGenerateStill,
} from "../../services/generateStill";
import {
  invokeReplicateGenerate,
  watchLabGenerate,
} from "../../services/labGenerate";
import type { ServiceRun } from "../../services/types";
import {
  parasceneAudioModelsForIntent,
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
  buildParasceneAudioArgs,
  buildReplicateAudioInput,
  buildVoiceCloneInput,
  parseVoiceCloneOutput,
  persistAudioGenerateExtras,
  pickLocalAudioPath,
  voiceIdFromCreationMeta,
  type ReplicateAudioGenerateExtras,
} from "./audioGenerateInputs";
import {
  loadCuratedReplicateAudioModels,
  REPLICATE_VOICE_CLONE_SLUG,
} from "./replicateAudioModels";
import {
  listenReplicateRunProgress,
  parseReplicateOwnerName,
  replicatePredictionWait,
} from "../../replicate/replicateClient";
import {
  draftAudioGenerateExtras,
  findResumableLibraryAssetPlaceholders,
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
  /** Resume wait for this Parascene creation instead of posting create again. */
  pendingCreationId?: string;
  onPlaceholderReserved?: (assetId: string) => void;
};

type LibraryAssetGenerationApplier = {
  beginPlaceholder: (opts: {
    id: string;
    aspectRatio: ProjectAspectRatio;
    draft: ReturnType<typeof makeLibraryAssetPlaceholderDraft>;
    kind?: "image" | "audio";
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
const resumeAttempted = new Set<string>();
const completingPlaceholders = new Set<string>();

function failLibraryPlaceholder(
  placeholderId: string,
  err: unknown,
  job: {
    provider: AddAssetGenerationJob["provider"];
    startedAt: string;
    model: string;
    serviceJobId?: string;
    extras?: ReplicateAudioGenerateExtras;
  },
): void {
  const message = err instanceof Error ? err.message : String(err);
  applier?.patchPlaceholder(placeholderId, {
    status: "error",
    progressNote: message,
    addAssetDraft: {
      lastError: message,
      audioExtras: persistAudioGenerateExtras(job.extras),
      // Same as timeline / library stills: drop the live job on terminal
      // failure so resume/zombie sweep does not re-watch a finished job.
      generationJob: undefined,
    },
  });
}

export function bindLibraryAssetGenerationApplier(
  next: LibraryAssetGenerationApplier | null,
): void {
  applier = next;
}

export function isLibraryAssetGenerationInflight(id: string): boolean {
  return inflight.has(id.trim());
}

export function __resetLibraryAssetGenerationStoreForTests(): void {
  inflight.clear();
  resumeAttempted.clear();
  completingPlaceholders.clear();
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

  if (
    (intentId === "text_to_speech" || intentId === "text_to_music") &&
    server === "parascene_blue"
  ) {
    const extras = draftAudioGenerateExtras(placeholder.addAssetDraft);
    const models = parasceneAudioModelsForIntent(intentId);
    const model =
      models.find((m) => m.id === modelStored)?.id ??
      models[0]?.id ??
      "";
    if (!model) return null;
    return startLibraryParasceneAudio({
      ...base,
      intentId,
      modelId: model,
      extras,
      pendingCreationId:
        placeholder.addAssetDraft.generationJob?.pendingCreationId?.trim() ||
        undefined,
    });
  }

  if (
    (intentId === "text_to_speech" || intentId === "text_to_music") &&
    server === "replicate"
  ) {
    const extras = draftAudioGenerateExtras(placeholder.addAssetDraft);
    if (modelStored === REPLICATE_VOICE_CLONE_SLUG) return null;
    const models = await loadCuratedReplicateAudioModels(intentId);
    const model =
      models.find((m) => m.id === modelStored) ?? models[0] ?? null;
    if (!model) return null;
    return startLibraryReplicateAudio({
      ...base,
      intentId,
      modelId: model.id,
      extras,
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
    pendingCreationId:
      placeholder.addAssetDraft.generationJob?.pendingCreationId?.trim() ||
      undefined,
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
  const isNewPlaceholder = !opts.placeholderId?.trim();
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
        pendingCreationId: opts.pendingCreationId?.trim() || undefined,
        model: opts.route.value,
      },
    },
  });
  if (isNewPlaceholder) applier.onGenerationStarted(placeholderId);
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
  let pendingCreationId: string | undefined =
    opts.pendingCreationId?.trim() || undefined;
  let serviceJobId: string | undefined;

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
          serviceJobId,
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
      creationToken: placeholderId,
      pendingCreationId,
      label: opts.route.label || opts.route.method,
    });
    if (handle.mode === "job") serviceJobId = handle.id;

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
      if (pendingCreationId) {
        void finishPlaceholderIfCatalogHasMedia({
          placeholderId,
          creationId: pendingCreationId,
          prompt: opts.prompt,
          destination,
        });
      }
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
    if (completingPlaceholders.has(placeholderId)) return;
    if (
      await finishPlaceholderIfCatalogHasMedia({
        placeholderId,
        creationId: pendingCreationId,
        prompt: opts.prompt,
        destination,
      })
    ) {
      return;
    }
    applier.patchPlaceholder(placeholderId, {
      status: "error",
      progressNote: message,
      addAssetDraft: {
        lastError: message,
        generationJob: {
          status: pendingCreationId ? "waiting" : "starting",
          provider: "parascene_blue",
          startedAt,
          pendingCreationId,
          serviceJobId,
          model: opts.route.value,
        },
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
  select?: boolean;
  intentId?: string;
  kind?: "image" | "audio";
  audioExtras?: ReplicateAudioGenerateExtras;
}): void {
  if (!applier) throw new Error("Library asset generation is not ready.");
  const draft = makeLibraryAssetPlaceholderDraft({
    prompt: opts.prompt,
    intentId: opts.intentId ?? "text_to_image",
    server: opts.server,
    provider: opts.provider,
    model: opts.model,
    audioExtras: opts.audioExtras,
  });
  applier.beginPlaceholder({
    id: opts.placeholderId,
    aspectRatio: opts.aspectRatio,
    kind: opts.kind === "audio" ? "audio" : "image",
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
  if (opts.select !== false) applier.onGenerationStarted(opts.placeholderId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Poll until Generate's catalog row has local thumb or media. */
export async function waitForCatalogLocalMedia(
  creationId: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<boolean> {
  const id = creationId.trim();
  if (!id) return false;
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const pollMs = opts?.pollMs ?? 250;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const row = await getCreation(id);
      if (hasLocalMedia(row)) return true;
    } catch {
      /* not in catalog yet */
    }
    await sleep(pollMs);
  }
  try {
    const row = await getCreation(id);
    return hasLocalMedia(row);
  } catch {
    return false;
  }
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
  await waitForCatalogLocalMedia(opts.creationId);
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

async function finishPlaceholderIfCatalogHasMedia(opts: {
  placeholderId: string;
  creationId: string | undefined;
  prompt: string;
  destination: CreationTarget;
}): Promise<boolean> {
  const creationId = opts.creationId?.trim();
  if (!creationId || completingPlaceholders.has(opts.placeholderId)) return false;
  try {
    const row = await getCreation(creationId);
    if (!hasLocalMedia(row)) return false;
  } catch {
    return false;
  }
  completingPlaceholders.add(opts.placeholderId);
  try {
    await finishLibraryTextToImagePlaceholder({
      placeholderId: opts.placeholderId,
      creationId,
      prompt: opts.prompt,
      destination: opts.destination,
    });
    return true;
  } finally {
    completingPlaceholders.delete(opts.placeholderId);
  }
}

/** File a library generate as a normal asset once local media exists. */
export function tryCompleteLibraryPlaceholderFromCatalog(opts: {
  placeholderId: string;
  creationId: string;
  prompt: string;
  destination?: CreationTarget;
}): void {
  void finishPlaceholderIfCatalogHasMedia({
    placeholderId: opts.placeholderId,
    creationId: opts.creationId,
    prompt: opts.prompt,
    destination: opts.destination ?? "assets",
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
    select: !opts.placeholderId?.trim(),
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
  let serviceJobId: string | undefined;

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
          serviceJobId,
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
    if (handle.mode === "job") serviceJobId = handle.id;
    patchJob(`Running ${opts.model.id}…`, "waiting");
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
    select: !opts.placeholderId?.trim(),
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
  let serviceJobId: string | undefined;

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
          serviceJobId,
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
    if (handle.mode === "job") serviceJobId = handle.id;
    patchJob("Running Text to Image on Direct to Blue…", "waiting");
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
  const isNewPlaceholder = !opts.placeholderId?.trim();
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
  if (isNewPlaceholder) applier.onGenerationStarted(placeholderId);
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
        void finishPlaceholderIfCatalogHasMedia({
          placeholderId,
          creationId: pendingCreationId,
          prompt: opts.prompt,
          destination: "assets",
        });
      },
    });

    pendingCreationId = result.creationId;
    patchJob(`Saving ${result.creationId} locally…`, "importing");
    await waitForCatalogLocalMedia(result.creationId);

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
    if (completingPlaceholders.has(placeholderId)) return;
    if (
      await finishPlaceholderIfCatalogHasMedia({
        placeholderId,
        creationId: pendingCreationId,
        prompt: opts.prompt,
        destination: "assets",
      })
    ) {
      return;
    }
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

export type StartLibraryReplicateAudioOpts = {
  projectId: string;
  aspectRatio: ProjectAspectRatio;
  prompt: string;
  intentId: "text_to_speech" | "text_to_music";
  modelId: string;
  extras?: ReplicateAudioGenerateExtras;
  destination?: CreationTarget;
  placeholderId?: string;
  onPlaceholderReserved?: (assetId: string) => void;
};

export function startLibraryReplicateAudio(
  opts: StartLibraryReplicateAudioOpts,
): string {
  if (!applier) {
    throw new Error("Library asset generation is not ready.");
  }
  const placeholderId =
    opts.placeholderId?.trim() || newLibraryAssetPlaceholderId();
  if (inflight.has(placeholderId)) return placeholderId;

  const startedAt = new Date().toISOString();
  const destination = opts.destination ?? "assets";
  beginLibraryTextToImagePlaceholder({
    placeholderId,
    aspectRatio: opts.aspectRatio,
    prompt: opts.prompt,
    server: "replicate",
    provider: "replicate",
    model: opts.modelId,
    startedAt,
    destination,
    select: !opts.placeholderId?.trim(),
    intentId: opts.intentId,
    kind: "audio",
    audioExtras: opts.extras,
  });
  opts.onPlaceholderReserved?.(placeholderId);

  inflight.add(placeholderId);
  void runLibraryReplicateAudio({
    ...opts,
    placeholderId,
    startedAt,
  }).finally(() => {
    inflight.delete(placeholderId);
  });

  return placeholderId;
}

async function stampLocalAudioProvenance(opts: {
  creationId: string;
  prompt: string;
  model: string;
  intentId: "text_to_speech" | "text_to_music";
  server?: "replicate" | "parascene_blue";
  extras?: ReplicateAudioGenerateExtras;
}): Promise<void> {
  try {
    const creation = await getCreation(opts.creationId);
    await applyManifest([
      creationUpsertWithAddAssetGeneration(
        creation,
        makeLibraryAudioGeneration({
          prompt: opts.prompt,
          creationId: opts.creationId,
          model: opts.model,
          intentId: opts.intentId,
          server: opts.server,
          extras: opts.extras,
        }),
      ),
    ]);
  } catch {
    // Provenance stamp is best-effort.
  }
}

async function runLibraryReplicateAudio(
  opts: StartLibraryReplicateAudioOpts & {
    placeholderId: string;
    startedAt: string;
  },
): Promise<void> {
  if (!applier) return;
  const { placeholderId, startedAt } = opts;
  const destination = opts.destination ?? "assets";
  const slug = parseReplicateOwnerName(opts.modelId);

  let serviceJobId: string | undefined;
  let replicatePredictionId: string | undefined;
  const extras = persistAudioGenerateExtras(opts.extras);
  const rememberPrediction = (id?: string | null) => {
    const trimmed = id?.trim();
    if (trimmed && !replicatePredictionId) replicatePredictionId = trimmed;
  };
  const patchJob = (note: string, status: AddAssetGenerationJob["status"]) => {
    applier?.patchPlaceholder(placeholderId, {
      status: "generating",
      progressNote: note,
      addAssetDraft: {
        audioExtras: extras,
        replicatePredictionId,
        generationJob: {
          status,
          provider: "replicate",
          startedAt,
          model: opts.modelId,
          serviceJobId,
          replicatePredictionId,
        },
      },
    });
  };

  try {
    if (!slug) throw new Error(`Unknown Replicate model ${opts.modelId}`);
    patchJob(`Running ${opts.modelId}…`, "starting");
    const input = buildReplicateAudioInput({
      modelId: opts.modelId,
      text: opts.prompt,
      extras: opts.extras,
    });
    const unlisten = await listenReplicateRunProgress((ev) => {
      if (ev.owner !== slug.owner || ev.name !== slug.name) return;
      rememberPrediction(ev.predictionId);
      const note = ev.message?.trim();
      if (note || ev.predictionId) {
        patchJob(note || `Running ${opts.modelId}…`, "waiting");
      }
    });
    try {
      const handle = await invokeReplicateGenerate({
        owner: slug.owner,
        name: slug.name,
        input,
        localFiles: {},
        requiredFileFields: [],
        projectId: opts.projectId,
        target: destination,
        clientRequestId: placeholderId,
        label: opts.modelId,
      });
      if (handle.mode === "job") serviceJobId = handle.id;
      patchJob(`Running ${opts.modelId}…`, "waiting");
      const result = await watchLocalGenerateStill(handle, {
        onUpdate: (run) => {
          rememberPrediction(predictionIdFromServiceRun(run));
          const note = run.progressNote?.trim();
          const lower = note?.toLowerCase() ?? "";
          const status: AddAssetGenerationJob["status"] = lower.includes("import")
            ? "importing"
            : "waiting";
          if (note) patchJob(note, status);
          else if (replicatePredictionId) patchJob(`Running ${opts.modelId}…`, status);
        },
      });
      rememberPrediction(result.predictionId);
      await stampLocalAudioProvenance({
        creationId: result.creationId,
        prompt: opts.prompt,
        model: opts.modelId,
        intentId: opts.intentId,
        extras,
      });
      await finishLibraryTextToImagePlaceholder({
        placeholderId,
        creationId: result.creationId,
        prompt: opts.prompt,
        destination,
      });
    } finally {
      unlisten();
    }
  } catch (err) {
    failLibraryPlaceholder(placeholderId, err, {
      provider: "replicate",
      startedAt,
      model: opts.modelId,
      serviceJobId,
      extras,
    });
  }
}

export type StartLibraryParasceneAudioOpts = {
  projectId: string;
  projectTitle?: string;
  imagesGroupId?: string | null;
  videosGroupId?: string | null;
  aspectRatio: ProjectAspectRatio;
  prompt: string;
  intentId: "text_to_speech" | "text_to_music";
  modelId: string;
  extras?: ReplicateAudioGenerateExtras;
  destination?: CreationTarget;
  placeholderId?: string;
  pendingCreationId?: string;
  onPlaceholderReserved?: (assetId: string) => void;
};

export function startLibraryParasceneAudio(
  opts: StartLibraryParasceneAudioOpts,
): string {
  if (!applier) {
    throw new Error("Library asset generation is not ready.");
  }
  const placeholderId =
    opts.placeholderId?.trim() || newLibraryAssetPlaceholderId();
  if (inflight.has(placeholderId)) return placeholderId;

  const startedAt = new Date().toISOString();
  const destination = opts.destination ?? "assets";
  beginLibraryTextToImagePlaceholder({
    placeholderId,
    aspectRatio: opts.aspectRatio,
    prompt: opts.prompt,
    server: "parascene_blue",
    provider: "parascene_blue",
    model: opts.modelId,
    startedAt,
    destination,
    select: !opts.placeholderId?.trim(),
    intentId: opts.intentId,
    kind: "audio",
    audioExtras: opts.extras,
  });
  opts.onPlaceholderReserved?.(placeholderId);

  inflight.add(placeholderId);
  void runLibraryParasceneAudio({
    ...opts,
    placeholderId,
    startedAt,
  }).finally(() => {
    inflight.delete(placeholderId);
  });

  return placeholderId;
}

async function runLibraryParasceneAudio(
  opts: StartLibraryParasceneAudioOpts & {
    placeholderId: string;
    startedAt: string;
  },
): Promise<void> {
  if (!applier) return;
  const { placeholderId, startedAt } = opts;
  const destination = opts.destination ?? "assets";
  const extras = persistAudioGenerateExtras(opts.extras);
  const method =
    opts.intentId === "text_to_music" ? "replicateMusic" : "replicateSpeech";
  let pendingCreationId = opts.pendingCreationId?.trim() || undefined;
  let serviceJobId: string | undefined;

  const patchJob = (note: string, status: AddAssetGenerationJob["status"]) => {
    applier?.patchPlaceholder(placeholderId, {
      status: "generating",
      progressNote: note,
      addAssetDraft: {
        audioExtras: extras,
        generationJob: {
          status,
          provider: "parascene_blue",
          startedAt,
          pendingCreationId,
          serviceJobId,
          model: opts.modelId,
        },
      },
    });
  };

  try {
    patchJob("Starting audio generation on Parascene…", "starting");
    const handle = await invokeParasceneGenerate({
      projectId: opts.projectId,
      projectTitle: opts.projectTitle?.trim() || "Project",
      imagesGroupId: opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
      serverId: 1,
      method,
      args: buildParasceneAudioArgs({
        modelId: opts.modelId,
        text: opts.prompt,
        extras: opts.extras,
      }),
      intent: opts.intentId,
      mediaType: "audio",
      target: destination,
      clientRequestId: placeholderId,
      creationToken: placeholderId,
      pendingCreationId,
      label: opts.modelId,
    });
    if (handle.mode === "job") serviceJobId = handle.id;
    const result = await watchParasceneGenerate(handle, {
      onUpdate: (run) => {
        const note = run.progressNote?.trim();
        const id = pendingCreationIdFromRun(run);
        if (id) pendingCreationId = id;
        if (note) patchJob(note, "waiting");
      },
    });
    await stampLocalAudioProvenance({
      creationId: result.creationId,
      prompt: opts.prompt,
      model: opts.modelId,
      intentId: opts.intentId,
      server: "parascene_blue",
      extras,
    });
    await finishLibraryTextToImagePlaceholder({
      placeholderId,
      creationId: result.creationId,
      prompt: opts.prompt,
      destination,
      projectCreationIds: result.projectCreationIds,
    });
  } catch (err) {
    failLibraryPlaceholder(placeholderId, err, {
      provider: "parascene_blue",
      startedAt,
      model: opts.modelId,
      serviceJobId,
      extras,
    });
  }
}

export type StartLibraryParasceneVoiceTrainOpts = {
  projectId: string;
  projectTitle?: string;
  aspectRatio: ProjectAspectRatio;
  sourceAssetId: string;
  sourceLabel?: string;
  placeholderId?: string;
  onPlaceholderReserved?: (assetId: string) => void;
  onVoiceReady?: (opts: { creationId: string; voiceId: string }) => void;
};

export function startLibraryParasceneVoiceTrain(
  opts: StartLibraryParasceneVoiceTrainOpts,
): string {
  if (!applier) {
    throw new Error("Library asset generation is not ready.");
  }
  const placeholderId =
    opts.placeholderId?.trim() || newLibraryAssetPlaceholderId();
  if (inflight.has(placeholderId)) return placeholderId;

  const startedAt = new Date().toISOString();
  const prompt = opts.sourceLabel?.trim() || "Voice train";
  beginLibraryTextToImagePlaceholder({
    placeholderId,
    aspectRatio: opts.aspectRatio,
    prompt,
    server: "parascene_blue",
    provider: "parascene_blue",
    model: "minimax/voice-cloning",
    startedAt,
    destination: "assets",
    select: !opts.placeholderId?.trim(),
    intentId: "text_to_speech",
    kind: "audio",
    audioExtras: persistAudioGenerateExtras({
      cloneSourceAssetId: opts.sourceAssetId,
    }),
  });
  opts.onPlaceholderReserved?.(placeholderId);

  inflight.add(placeholderId);
  void runLibraryParasceneVoiceTrain({
    ...opts,
    placeholderId,
    startedAt,
    prompt,
  }).finally(() => {
    inflight.delete(placeholderId);
  });

  return placeholderId;
}

async function runLibraryParasceneVoiceTrain(
  opts: StartLibraryParasceneVoiceTrainOpts & {
    placeholderId: string;
    startedAt: string;
    prompt: string;
  },
): Promise<void> {
  if (!applier) return;
  const { placeholderId, startedAt } = opts;
  const extras = persistAudioGenerateExtras({
    cloneSourceAssetId: opts.sourceAssetId,
  });
  let pendingCreationId: string | undefined;
  let serviceJobId: string | undefined;

  const patchJob = (note: string, status: AddAssetGenerationJob["status"]) => {
    applier?.patchPlaceholder(placeholderId, {
      status: "generating",
      progressNote: note,
      addAssetDraft: {
        audioExtras: extras,
        generationJob: {
          status,
          provider: "parascene_blue",
          startedAt,
          pendingCreationId,
          serviceJobId,
          model: "minimax/voice-cloning",
        },
      },
    });
  };

  try {
    const sourceAssetId = opts.sourceAssetId.trim();
    if (!sourceAssetId) throw new Error("Pick a Library audio file to train.");
    patchJob("Training voice on Parascene…", "starting");
    const handle = await invokeParasceneGenerate({
      projectId: opts.projectId,
      projectTitle: opts.projectTitle?.trim() || "Project",
      serverId: 1,
      method: "replicateVoiceTrain",
      args: { voice_file: sourceAssetId },
      intent: "voice_train",
      mediaType: "audio",
      target: "assets",
      clientRequestId: placeholderId,
      creationToken: placeholderId,
      label: "replicateVoiceTrain",
    });
    if (handle.mode === "job") serviceJobId = handle.id;
    const result = await watchParasceneGenerate(handle, {
      onUpdate: (run) => {
        const note = run.progressNote?.trim();
        const id = pendingCreationIdFromRun(run);
        if (id) pendingCreationId = id;
        if (note) patchJob(note, "waiting");
      },
    });
    const creation = await getCreation(result.creationId);
    const voiceId = voiceIdFromCreationMeta(creation);
    if (!voiceId) {
      throw new Error("Voice train finished without a voice_id.");
    }
    await stampLocalAudioProvenance({
      creationId: result.creationId,
      prompt: opts.prompt,
      model: "minimax/voice-cloning",
      intentId: "text_to_speech",
      server: "parascene_blue",
      extras: { voiceId, cloneSourceAssetId: sourceAssetId },
    });
    await finishLibraryTextToImagePlaceholder({
      placeholderId,
      creationId: result.creationId,
      prompt: opts.prompt,
      destination: "assets",
      projectCreationIds: result.projectCreationIds,
    });
    opts.onVoiceReady?.({ creationId: result.creationId, voiceId });
  } catch (err) {
    failLibraryPlaceholder(placeholderId, err, {
      provider: "parascene_blue",
      startedAt,
      model: "minimax/voice-cloning",
      serviceJobId,
      extras,
    });
  }
}

export type StartLibraryVoiceCloneOpts = {
  projectId: string;
  aspectRatio: ProjectAspectRatio;
  sourcePath: string;
  sourceLabel?: string;
  sourceAssetId?: string;
  placeholderId?: string;
  onPlaceholderReserved?: (assetId: string) => void;
  onVoiceReady?: (opts: { creationId: string; voiceId: string }) => void;
};

export function startLibraryVoiceClone(opts: StartLibraryVoiceCloneOpts): string {
  if (!applier) {
    throw new Error("Library asset generation is not ready.");
  }
  const placeholderId =
    opts.placeholderId?.trim() || newLibraryAssetPlaceholderId();
  if (inflight.has(placeholderId)) return placeholderId;

  const startedAt = new Date().toISOString();
  const prompt = opts.sourceLabel?.trim() || "Voice clone";
  beginLibraryTextToImagePlaceholder({
    placeholderId,
    aspectRatio: opts.aspectRatio,
    prompt,
    server: "replicate",
    provider: "replicate",
    model: REPLICATE_VOICE_CLONE_SLUG,
    startedAt,
    destination: "assets",
    select: !opts.placeholderId?.trim(),
    intentId: "text_to_speech",
    kind: "audio",
    audioExtras: persistAudioGenerateExtras({
      cloneSourceAssetId: opts.sourceAssetId,
    }),
  });
  opts.onPlaceholderReserved?.(placeholderId);

  inflight.add(placeholderId);
  void runLibraryVoiceClone({
    ...opts,
    placeholderId,
    startedAt,
    prompt,
  }).finally(() => {
    inflight.delete(placeholderId);
  });

  return placeholderId;
}

async function runLibraryVoiceClone(
  opts: StartLibraryVoiceCloneOpts & {
    placeholderId: string;
    startedAt: string;
    prompt: string;
  },
): Promise<void> {
  if (!applier) return;
  const { placeholderId, startedAt } = opts;
  const slug = parseReplicateOwnerName(REPLICATE_VOICE_CLONE_SLUG);

  let serviceJobId: string | undefined;
  let replicatePredictionId: string | undefined;
  const extras = persistAudioGenerateExtras({
    cloneSourceAssetId: opts.sourceAssetId,
  });
  const rememberPrediction = (id?: string | null) => {
    const trimmed = id?.trim();
    if (trimmed && !replicatePredictionId) replicatePredictionId = trimmed;
  };
  const patchJob = (note: string, status: AddAssetGenerationJob["status"]) => {
    applier?.patchPlaceholder(placeholderId, {
      status: "generating",
      progressNote: note,
      addAssetDraft: {
        audioExtras: extras,
        replicatePredictionId,
        generationJob: {
          status,
          provider: "replicate",
          startedAt,
          model: REPLICATE_VOICE_CLONE_SLUG,
          serviceJobId,
          replicatePredictionId,
        },
      },
    });
  };

  try {
    if (!slug) throw new Error("Voice cloning model is missing.");
    const sourcePath = opts.sourcePath.trim();
    if (!sourcePath) throw new Error("Pick a Library audio file to clone.");
    patchJob("Cloning voice…", "starting");
    const unlisten = await listenReplicateRunProgress((ev) => {
      if (ev.owner !== slug.owner || ev.name !== slug.name) return;
      rememberPrediction(ev.predictionId);
      const note = ev.message?.trim();
      if (note || ev.predictionId) patchJob(note || "Cloning voice…", "waiting");
    });
    try {
      const handle = await invokeReplicateGenerate({
        owner: slug.owner,
        name: slug.name,
        input: buildVoiceCloneInput(),
        localFiles: { voice_file: sourcePath },
        requiredFileFields: ["voice_file"],
        label: REPLICATE_VOICE_CLONE_SLUG,
        clientRequestId: placeholderId,
      });
      if (handle.mode === "job") serviceJobId = handle.id;
      patchJob("Cloning voice…", "waiting");
      const result = await watchLabGenerate(handle, {
        onUpdate: (run) => {
          rememberPrediction(predictionIdFromServiceRun(run));
          const note = run.progressNote?.trim();
          if (note) patchJob(note, "waiting");
        },
      });
      rememberPrediction(result.predictionId);
      const finished = await finishVoiceCloneImport({
        placeholderId,
        projectId: opts.projectId,
        prompt: opts.prompt,
        result,
        patchJob,
      });
      opts.onVoiceReady?.(finished);
    } finally {
      unlisten();
    }
  } catch (err) {
    failLibraryPlaceholder(placeholderId, err, {
      provider: "replicate",
      startedAt,
      model: REPLICATE_VOICE_CLONE_SLUG,
      serviceJobId,
      extras,
    });
  }
}

async function finishVoiceCloneImport(opts: {
  placeholderId: string;
  projectId: string;
  prompt: string;
  result: Parameters<typeof parseVoiceCloneOutput>[0];
  patchJob: (note: string, status: AddAssetGenerationJob["status"]) => void;
}): Promise<{ creationId: string; voiceId: string }> {
  const parsed = parseVoiceCloneOutput(opts.result);
  if (!parsed.voiceId) {
    throw new Error("Voice clone finished without a voice_id.");
  }
  const previewPath = parsed.previewPath;
  if (!previewPath) {
    throw new Error("Voice clone finished without a 5s preview audio file.");
  }
  opts.patchJob("Trimming preview…", "importing");
  let importPath = previewPath;
  try {
    const sliced = await sliceAudioRange({
      sourcePath: previewPath,
      inSec: 0,
      outSec: 5,
    });
    if (sliced.path.trim()) importPath = sliced.path;
  } catch {
    importPath = previewPath;
  }
  const imported = await importLocalPathsForProject({
    projectId: opts.projectId,
    paths: [importPath],
  });
  const creationId = imported.creations[0]?.id?.trim();
  if (!creationId) {
    throw new Error("Could not import the cloned voice preview.");
  }
  await stampLocalAudioProvenance({
    creationId,
    prompt: opts.prompt,
    model: REPLICATE_VOICE_CLONE_SLUG,
    intentId: "text_to_speech",
    extras: { voiceId: parsed.voiceId },
  });
  await finishLibraryTextToImagePlaceholder({
    placeholderId: opts.placeholderId,
    creationId,
    prompt: opts.prompt,
    destination: "assets",
  });
  return { creationId, voiceId: parsed.voiceId };
}

async function finishLibraryFromReplicatePrediction(opts: {
  placeholderId: string;
  projectId: string;
  predictionId: string;
  prompt: string;
  model: string;
  kind: "image" | "audio";
  intentId?: string;
  extras?: ReplicateAudioGenerateExtras;
  destination: CreationTarget;
  patchJob: (note: string, status: AddAssetGenerationJob["status"]) => void;
}): Promise<void> {
  opts.patchJob(`Resuming Replicate wait (${opts.predictionId})…`, "waiting");
  const result = await replicatePredictionWait(opts.predictionId);
  if (
    result.error ||
    result.status === "failed" ||
    result.status === "canceled" ||
    result.status === "cancelled"
  ) {
    throw new Error(
      result.error?.trim() || `Replicate ${result.status || "failed"}`,
    );
  }
  const path =
    opts.kind === "audio"
      ? pickLocalAudioPath(result.localPaths)
      : result.localPaths.map((row) => row.trim()).find(Boolean) ?? null;
  if (!path) {
    throw new Error("Replicate finished without a local file.");
  }
  opts.patchJob("Import into Assets…", "importing");
  const imported = await importLocalPathsForProject({
    projectId: opts.projectId,
    paths: [path],
  });
  const creationId = imported.creations[0]?.id?.trim();
  if (!creationId) {
    throw new Error("Could not import Replicate output.");
  }
  if (opts.kind === "audio") {
    await stampLocalAudioProvenance({
      creationId,
      prompt: opts.prompt,
      model: opts.model,
      intentId:
        opts.intentId === "text_to_music" ? "text_to_music" : "text_to_speech",
      extras: opts.extras,
    });
  }
  await finishLibraryTextToImagePlaceholder({
    placeholderId: opts.placeholderId,
    creationId,
    prompt: opts.prompt,
    destination: opts.destination,
  });
}

export function cancelLibraryAssetGeneration(
  placeholder: Pick<LibraryAssetPlaceholder, "id" | "addAssetDraft">,
): void {
  const id = placeholder.id.trim();
  if (!id) return;
  inflight.delete(id);
  resumeAttempted.add(id);
  const serviceJobId = placeholder.addAssetDraft.generationJob?.serviceJobId?.trim();
  if (serviceJobId) {
    void cancelGenerateStillJob(serviceJobId).catch(() => {});
  }
  failLibraryPlaceholder(id, new Error("Cancelled"), {
    provider: placeholder.addAssetDraft.generationJob?.provider ?? "replicate",
    startedAt:
      placeholder.addAssetDraft.generationJob?.startedAt ??
      new Date().toISOString(),
    model:
      placeholder.addAssetDraft.generationJob?.model?.trim() ||
      placeholder.addAssetDraft.replicateModel?.trim() ||
      "",
    extras: draftAudioGenerateExtras(placeholder.addAssetDraft),
  });
}

export function reconcileLibraryAssetGenerations(opts: {
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  placeholders: Record<string, LibraryAssetPlaceholder>;
}): boolean {
  let started = false;
  for (const placeholder of findResumableLibraryAssetPlaceholders(
    opts.placeholders,
  )) {
    if (inflight.has(placeholder.id) || resumeAttempted.has(placeholder.id)) {
      continue;
    }
    const job = placeholder.addAssetDraft.generationJob;
    const serviceJobId = job?.serviceJobId?.trim();
    const predictionId =
      job?.replicatePredictionId?.trim() ||
      placeholder.addAssetDraft.replicatePredictionId?.trim() ||
      "";
    if (!job || (!serviceJobId && !predictionId)) continue;
    const extras = draftAudioGenerateExtras(placeholder.addAssetDraft);
    const startedAt = job.startedAt;
    const model = job.model?.trim() || placeholder.addAssetDraft.replicateModel?.trim() || "";
    inflight.add(placeholder.id);
    resumeAttempted.add(placeholder.id);
    started = true;
    const isClone = model === REPLICATE_VOICE_CLONE_SLUG;
    const provider = job.provider ?? "replicate";
    void (async () => {
      const patchJob = (
        note: string,
        status: AddAssetGenerationJob["status"],
      ) => {
        applier?.patchPlaceholder(placeholder.id, {
          status: "generating",
          progressNote: note,
          addAssetDraft: {
            audioExtras: extras,
            lastError: undefined,
            generationJob: {
              status,
              provider,
              startedAt,
              model,
              serviceJobId: serviceJobId || undefined,
              replicatePredictionId: predictionId || undefined,
            },
            replicatePredictionId: predictionId || undefined,
          },
        });
      };
      try {
        patchJob("Resuming generation…", "waiting");
        if (isClone) {
          if (serviceJobId) {
            try {
              const result = await watchLabGenerate(
                { mode: "job", id: serviceJobId },
                {
                  onUpdate: (run) => {
                    const note = run.progressNote?.trim();
                    if (note) patchJob(note, "waiting");
                  },
                },
              );
              await finishVoiceCloneImport({
                placeholderId: placeholder.id,
                projectId: opts.projectId,
                prompt: placeholder.addAssetDraft.prompt?.trim() || "Voice clone",
                result,
                patchJob,
              });
              return;
            } catch (err) {
              if (!predictionId) throw err;
            }
          }
          if (!predictionId) {
            throw new Error("No Replicate prediction id to resume voice clone.");
          }
          const result = await replicatePredictionWait(predictionId);
          await finishVoiceCloneImport({
            placeholderId: placeholder.id,
            projectId: opts.projectId,
            prompt: placeholder.addAssetDraft.prompt?.trim() || "Voice clone",
            result,
            patchJob,
          });
          return;
        }
        if (serviceJobId) {
          try {
            const watch =
              provider === "parascene_blue"
                ? watchParasceneGenerateStill
                : watchLocalGenerateStill;
            const result = await watch(
              { mode: "job", id: serviceJobId },
              {
                onUpdate: (run) => {
                  const note = run.progressNote?.trim();
                  if (note) patchJob(note, "waiting");
                },
              },
            );
            if (placeholder.kind === "audio") {
              const intentId =
                placeholder.addAssetDraft.intentId === "text_to_music"
                  ? "text_to_music"
                  : "text_to_speech";
              await stampLocalAudioProvenance({
                creationId: result.creationId,
                prompt: placeholder.addAssetDraft.prompt?.trim() || "",
                model,
                intentId,
                server:
                  provider === "parascene_blue" ? "parascene_blue" : "replicate",
                extras,
              });
            }
            await finishLibraryTextToImagePlaceholder({
              placeholderId: placeholder.id,
              creationId: result.creationId,
              prompt: placeholder.addAssetDraft.prompt?.trim() || "",
              destination:
                placeholder.addAssetDraft.generateDestination === "timeline"
                  ? "timeline"
                  : "assets",
              projectCreationIds:
                "projectCreationIds" in result
                  ? result.projectCreationIds
                  : undefined,
              imagesGroupId:
                "imagesGroupId" in result ? result.imagesGroupId : undefined,
            });
            return;
          } catch (err) {
            if (!predictionId) throw err;
          }
        }
        if (!predictionId) {
          throw new Error("No Replicate prediction id to resume generation.");
        }
        await finishLibraryFromReplicatePrediction({
          placeholderId: placeholder.id,
          projectId: opts.projectId,
          predictionId,
          prompt: placeholder.addAssetDraft.prompt?.trim() || "",
          model,
          kind: placeholder.kind,
          intentId: placeholder.addAssetDraft.intentId,
          extras,
          destination:
            placeholder.addAssetDraft.generateDestination === "timeline"
              ? "timeline"
              : "assets",
          patchJob,
        });
      } catch (err) {
        failLibraryPlaceholder(placeholder.id, err, {
          provider,
          startedAt,
          model,
          serviceJobId,
          extras,
        });
      } finally {
        inflight.delete(placeholder.id);
        resumeAttempted.delete(placeholder.id);
      }
    })();
  }
  return started;
}

export function libraryAssetGenerationFromPlaceholder(
  placeholder: {
    addAssetDraft: {
      prompt?: string;
      replicateModel?: string;
      server?: string;
      intentId?: string;
      audioExtras?: ReplicateAudioGenerateExtras;
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
  const intentId = placeholder.addAssetDraft.intentId?.trim();
  if (intentId === "text_to_speech" || intentId === "text_to_music") {
    return makeLibraryAudioGeneration({
      prompt,
      creationId,
      model: placeholder.addAssetDraft.replicateModel ?? "",
      intentId,
      server: serverRaw === "parascene_blue" ? "parascene_blue" : "replicate",
      extras: persistAudioGenerateExtras(placeholder.addAssetDraft.audioExtras),
    });
  }
  return makeTextToImageGeneration({
    prompt,
    creationId,
    model: placeholder.addAssetDraft.replicateModel ?? "",
    server,
  });
}
