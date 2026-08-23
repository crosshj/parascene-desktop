/**
 * In-flight Generate → Assets jobs keyed by project placeholder id.
 * Survives leaving the + slot — UI reads {@link LibraryAssetPlaceholder} on the project.
 */

import { applyManifest, getCreation } from "../../library/catalogClient";
import type { ProjectAspectRatio } from "../../project/aspectRatios";
import type { AddAssetDraft, AddAssetGeneration } from "../../project/types";
import type { AddAssetGenerationJob } from "../../project/types";
import {
  creationUpsertWithAddAssetGeneration,
  makeTextToImageGeneration,
  makeImageToImageGeneration,
} from "../../project/desktopAddAssetGeneration";
import {
  parasceneResolveStillModel,
  parasceneStillModelFamilies,
  type ParasceneStillModelOption,
} from "./parasceneProductCaps";
import { runParasceneTextToImage } from "./runParasceneTextToImage";
import { runParasceneImageToImage } from "./runParasceneImageToImage";
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
export function retryLibraryAssetPlaceholder(
  opts: RetryLibraryAssetPlaceholderOpts,
): string | null {
  const { placeholder } = opts;
  const prompt = placeholder.addAssetDraft.prompt?.trim() ?? "";
  if (!prompt) return null;

  const modelStored = placeholder.addAssetDraft.replicateModel?.trim() ?? "";
  const intentId = placeholder.addAssetDraft.intentId?.trim() ?? "text_to_image";
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
    const result = await runParasceneTextToImage({
      prompt: opts.prompt,
      aspectRatio: opts.aspectRatio,
      modelId: opts.modelId,
      route: opts.route,
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
      imagesGroupId: opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
      onCreationStarted: async (creationId) => {
        pendingCreationId = creationId;
        patchJob(`Waiting for ${creationId}…`, "waiting");
      },
      onProgress: (note) => {
        const lower = note.toLowerCase();
        const status: AddAssetGenerationJob["status"] = lower.includes(
          "syncing",
        )
          ? "importing"
          : lower.includes("filing")
            ? "importing"
            : "waiting";
        patchJob(note, status);
      },
    });

    if (result.projectCreationIds.length > 0) {
      await applier.addCreations(result.projectCreationIds);
    }
    if (result.imagesGroupId) {
      applier.setImagesGroupId(result.imagesGroupId);
    }

    const generation = makeTextToImageGeneration({
      prompt: opts.prompt,
      creationId: result.creationId,
      model: opts.route.value,
      server: "parascene_blue",
    });

    try {
      const creation = await getCreation(result.creationId);
      await applyManifest([
        creationUpsertWithAddAssetGeneration(creation, generation),
      ]);
    } catch {
      /* manifest optional — selection preview may lag one tick */
    }

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

    if (result.projectCreationIds.length > 0) {
      await applier.addCreations(result.projectCreationIds);
    }
    if (result.imagesGroupId) {
      applier.setImagesGroupId(result.imagesGroupId);
    }

    const generation = makeImageToImageGeneration({
      prompt: opts.prompt,
      creationId: result.creationId,
      model: opts.route.value,
      server: "parascene_blue",
      sourceCreationId: opts.sourceCreationId,
    });

    try {
      const creation = await getCreation(result.creationId);
      await applyManifest([
        creationUpsertWithAddAssetGeneration(creation, generation),
      ]);
    } catch {
      /* manifest optional — selection preview may lag one tick */
    }

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
    addAssetDraft: { prompt?: string; replicateModel?: string };
    addAssetGeneration?: AddAssetGeneration;
  } | null,
  creationId: string,
): AddAssetGeneration | null {
  if (placeholder?.addAssetGeneration) return placeholder.addAssetGeneration;
  const prompt = placeholder?.addAssetDraft.prompt?.trim();
  if (!placeholder || !prompt) return null;
  return makeTextToImageGeneration({
    prompt,
    creationId,
    model: placeholder.addAssetDraft.replicateModel ?? "",
    server: "parascene_blue",
  });
}
