import type { ProjectAspectRatio } from "../../project/aspectRatios";
import type {
  AddAssetDraft,
  AddAssetGeneration,
  AddAssetGenerationJob,
} from "../../project/types";
import {
  activeLibraryAssetPlaceholders,
  type LibraryAssetPlaceholder,
} from "../../project/libraryAssetPlaceholder";
import {
  persistAudioGenerateExtras,
  type ReplicateAudioGenerateExtras,
} from "./audioGenerateInputs";
import { isLibraryAudioGeneration } from "../../project/desktopAddAssetGeneration";

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
  serviceJobId?: string;
  audioExtras?: ReplicateAudioGenerateExtras;
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
    audioExtras: persistAudioGenerateExtras(opts.audioExtras),
    generationJob: {
      status: "waiting",
      provider: opts.provider,
      startedAt: now,
      pendingCreationId: opts.pendingCreationId,
      replicatePredictionId: opts.replicatePredictionId,
      blueJobId: opts.blueJobId,
      serviceJobId: opts.serviceJobId,
      model: opts.model,
    },
  };
}

export function draftAudioGenerateExtras(
  draft: AddAssetDraft | null | undefined,
): ReplicateAudioGenerateExtras | undefined {
  return persistAudioGenerateExtras(draft?.audioExtras);
}

/** Seed Generate → Assets from a finished speech / music asset. */
export function libraryAudioCloneSeed(
  generation: AddAssetGeneration | null | undefined,
): {
  intentId: "text_to_speech" | "text_to_music";
  prompt: string;
  model?: string;
  extras?: ReplicateAudioGenerateExtras;
} | null {
  if (!isLibraryAudioGeneration(generation) || !generation) return null;
  const intentId =
    generation.intentId === "text_to_music" ? "text_to_music" : "text_to_speech";
  const model = generation.model?.trim() || undefined;
  const stored = generation.audioExtras;
  const voice =
    stored?.voiceId?.trim() ||
    stored?.geminiVoice?.trim() ||
    generation.voiceId?.trim() ||
    undefined;
  return {
    intentId,
    prompt: generation.prompt.trim(),
    model,
    extras: persistAudioGenerateExtras({
      ...stored,
      // Both form fields so MiniMax and Gemini keep the speaker.
      voiceId: voice,
      geminiVoice: voice,
      stylePrompt: stored?.stylePrompt ?? generation.stylePrompt,
      lyrics: stored?.lyrics ?? generation.lyricsText,
    }),
  };
}

/** Placeholders with a persisted remote job that can be reattached. */
export function findResumableLibraryAssetPlaceholders(
  placeholders: Record<string, LibraryAssetPlaceholder> | undefined,
): LibraryAssetPlaceholder[] {
  return activeLibraryAssetPlaceholders(placeholders).filter((placeholder) => {
    if (placeholder.status !== "generating") return false;
    const job = placeholder.addAssetDraft.generationJob;
    if (!job) return false;
    if (job.status === "timed_out") return false;
    return (
      Boolean(job.serviceJobId?.trim()) ||
      Boolean(job.replicatePredictionId?.trim()) ||
      Boolean(placeholder.addAssetDraft.replicatePredictionId?.trim()) ||
      Boolean(job.pendingCreationId?.trim()) ||
      Boolean(job.blueJobId?.trim())
    );
  });
}

export function makeLibraryAssetPlaceholder(opts: {
  id: string;
  aspectRatio: ProjectAspectRatio;
  draft: AddAssetDraft;
  kind?: "image" | "audio";
}): LibraryAssetPlaceholder {
  const now = new Date().toISOString();
  return {
    id: opts.id,
    kind: opts.kind === "audio" ? "audio" : "image",
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
