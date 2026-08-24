import type { ProjectAspectRatio } from "../../project/aspectRatios";
import type { AddAssetDraft, AddAssetGenerationJob } from "../../project/types";
import type { LibraryAssetPlaceholder } from "../../project/libraryAssetPlaceholder";

export type LibraryPlaceholderResultStep = {
  id: string;
  label: string;
  status: "pending" | "active" | "done";
};

export function newLibraryAssetPlaceholderId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `asset-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function makeLibraryAssetPlaceholderDraft(opts: {
  prompt: string;
  intentId: string;
  server: string;
  provider: AddAssetGenerationJob["provider"];
  model?: string;
  startFrameAssetId?: string;
  pendingCreationId?: string;
  replicatePredictionId?: string;
  blueJobId?: string;
}): AddAssetDraft {
  const now = new Date().toISOString();
  return {
    prompt: opts.prompt.trim(),
    intentId: opts.intentId,
    server: opts.server,
    methodId: opts.intentId,
    provider: opts.provider,
    replicateModel: opts.model,
    startFrameAssetId: opts.startFrameAssetId,
    generationJob: {
      status: "waiting",
      provider: opts.provider,
      startedAt: now,
      pendingCreationId: opts.pendingCreationId,
      replicatePredictionId: opts.replicatePredictionId,
      blueJobId: opts.blueJobId,
      model: opts.model,
    },
  };
}

export function makeLibraryAssetPlaceholder(opts: {
  id: string;
  aspectRatio: ProjectAspectRatio;
  draft: AddAssetDraft;
}): LibraryAssetPlaceholder {
  const now = new Date().toISOString();
  return {
    id: opts.id,
    kind: "image",
    aspectRatio: opts.aspectRatio,
    status: "generating",
    addAssetDraft: opts.draft,
    createdAt: now,
    updatedAt: now,
  };
}

/** Result-pane steps derived from persisted placeholder job state. */
export function libraryPlaceholderResultSteps(
  placeholder: LibraryAssetPlaceholder | null | undefined,
): LibraryPlaceholderResultStep[] {
  if (!placeholder) return [];
  const job = placeholder.addAssetDraft.generationJob;
  const provider = job?.provider ?? placeholder.addAssetDraft.provider;
  const isLocal =
    provider === "replicate" || provider === "blue_direct";
  const waitLabel = isLocal ? "Wait for output" : "Wait for Parascene";
  const syncLabel = isLocal ? "Import into Assets" : "Sync to Library";
  const steps: LibraryPlaceholderResultStep[] = [
    { id: "start", label: "Start generation", status: "pending" },
    { id: "wait", label: waitLabel, status: "pending" },
    { id: "sync", label: syncLabel, status: "pending" },
    { id: "file", label: "Add to Assets", status: "pending" },
  ];
  if (!job) return steps;
  const note = placeholder.progressNote?.toLowerCase() ?? "";
  if (job.status === "starting") {
    steps[0] = { ...steps[0], status: "active" };
    return steps;
  }
  steps[0] = { ...steps[0], status: "done" };
  if (job.status === "waiting" && !note.includes("syncing") && !note.includes("filing")) {
    steps[1] = { ...steps[1], status: "active" };
    return steps;
  }
  steps[1] = { ...steps[1], status: "done" };
  if (note.includes("filing")) {
    steps[2] = { ...steps[2], status: "done" };
    steps[3] = { ...steps[3], status: "active" };
    return steps;
  }
  if (note.includes("syncing")) {
    steps[2] = { ...steps[2], status: "active" };
    return steps;
  }
  if (job.status === "downloading" || job.status === "importing") {
    steps[2] = { ...steps[2], status: "active" };
    return steps;
  }
  steps[2] = { ...steps[2], status: "done" };
  steps[3] = { ...steps[3], status: "active" };
  return steps;
}
