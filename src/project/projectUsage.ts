import { normalizeStoredTimeline, type StoredProject } from "./projectStore";
import { normalizeStillWorkstreams } from "./stillWorkstream";

export type ProjectAssetUsage = {
  creationId: string;
  usageKind: string;
  usageOwnerId: string;
  usageOwnerLabel: string;
};

/**
 * The single registry of persisted creation references that protect Library
 * removal/deletion. Add every new project reference type here with a test.
 */
export function collectProjectAssetUsage(
  project: StoredProject,
): ProjectAssetUsage[] {
  const rows = new Map<string, ProjectAssetUsage>();
  const add = (
    creationId: string | null | undefined,
    usageKind: string,
    ownerId: string,
    ownerLabel: string,
  ) => {
    const id = creationId?.trim();
    if (!id) return;
    const key = `${id}\0${usageKind}\0${ownerId}`;
    rows.set(key, {
      creationId: id,
      usageKind,
      usageOwnerId: ownerId,
      usageOwnerLabel: ownerLabel,
    });
  };

  for (const clip of normalizeStoredTimeline(project.timeline)) {
    const label = clip.label.trim() || "Timeline clip";
    add(clip.assetId, "timeline_clip", clip.id, label);
    for (const id of clip.slideshow?.imageAssetIds ?? []) {
      add(id, "slideshow_image", clip.id, label);
    }
    add(clip.slideshow?.audioAssetId, "slideshow_audio", clip.id, label);
    add(
      clip.addAssetDraft?.startFrameAssetId,
      "generation_start_frame",
      clip.id,
      label,
    );
    add(
      clip.addAssetDraft?.firstFrameSource?.kind === "asset"
        ? clip.addAssetDraft.firstFrameSource.assetId
        : undefined,
      "generation_start_frame",
      clip.id,
      label,
    );
    add(
      clip.addAssetDraft?.lastFrameSource?.kind === "asset"
        ? clip.addAssetDraft.lastFrameSource.assetId
        : undefined,
      "generation_start_frame",
      clip.id,
      label,
    );
    add(
      clip.addAssetGeneration?.startFrameAssetId,
      "generation_start_frame",
      clip.id,
      label,
    );
    add(
      clip.addAssetGeneration?.firstFrameSource?.kind === "asset"
        ? clip.addAssetGeneration.firstFrameSource.assetId
        : undefined,
      "generation_start_frame",
      clip.id,
      label,
    );
    add(
      clip.addAssetGeneration?.lastFrameSource?.kind === "asset"
        ? clip.addAssetGeneration.lastFrameSource.assetId
        : undefined,
      "generation_start_frame",
      clip.id,
      label,
    );
    add(
      clip.addAssetGeneration?.creationId,
      "generated_timeline_clip",
      clip.id,
      label,
    );
  }

  for (const stream of normalizeStillWorkstreams(project.stillWorkstreams)) {
    const label = stream.title.trim() || "Composition";
    for (const id of stream.memberIds) {
      add(id, "composition_member", stream.id, label);
    }
    for (const node of stream.nodes) {
      if (node.status === "discarded") continue;
      add(node.creationId, "composition_node", node.id, label);
    }
  }

  add(project.mainAudioCreationId, "main_audio", project.id, "Main audio");
  add(
    project.lyricAlignment?.sourceAudioCreationId,
    "lyric_source_audio",
    project.id,
    "Lyric alignment",
  );
  add(
    project.storyboardProposal?.sourceAudioCreationId,
    "storyboard_source_audio",
    project.id,
    "Storyboard",
  );
  for (const step of project.storyboardProposal?.generationPlan?.steps ?? []) {
    add(step.creationId, "storyboard_generation", step.id, step.label);
    if (step.stillSource?.mode === "project_image") {
      add(
        step.stillSource.creationId,
        "storyboard_project_image",
        step.id,
        step.label,
      );
    }
  }

  add(project.imagesGroupId, "project_cabinet", "images", "Project Images");
  add(project.videosGroupId, "project_cabinet", "videos", "Project Videos");

  return [...rows.values()];
}

export function collectProjectReferencedCreationIds(
  project: StoredProject,
): string[] {
  return [
    ...new Set(collectProjectAssetUsage(project).map((row) => row.creationId)),
  ];
}

export type MissingProjectReference = {
  creationId: string;
  usageKind: string;
  usageOwnerLabel: string;
};

/** Where missing Library IDs are still referenced in the project document. */
export function describeMissingProjectReferences(
  project: StoredProject,
  missingIds: readonly string[],
): MissingProjectReference[] {
  const missing = new Set(
    missingIds.map((id) => id.trim()).filter(Boolean),
  );
  if (missing.size === 0) return [];
  const byId = new Map<string, MissingProjectReference>();
  for (const row of collectProjectAssetUsage(project)) {
    if (!missing.has(row.creationId) || byId.has(row.creationId)) continue;
    byId.set(row.creationId, {
      creationId: row.creationId,
      usageKind: row.usageKind,
      usageOwnerLabel: row.usageOwnerLabel,
    });
  }
  return [...byId.values()];
}

function usageKindLabel(kind: string): string {
  switch (kind) {
    case "timeline_clip":
      return "timeline clip";
    case "slideshow_image":
    case "slideshow_audio":
      return "slideshow";
    case "generation_start_frame":
    case "generated_timeline_clip":
      return "timeline generation";
    case "composition_member":
    case "composition_node":
      return "composition";
    case "main_audio":
      return "main audio";
    case "lyric_source_audio":
      return "lyric alignment";
    case "storyboard_source_audio":
    case "storyboard_generation":
    case "storyboard_project_image":
      return "storyboard / MV Build";
    case "project_cabinet":
      return "Images/Videos cabinet";
    default:
      return kind;
  }
}

/** Human-readable lines for the open-missing-files dialog. */
export function formatMissingProjectReferenceLines(
  refs: readonly MissingProjectReference[],
): string[] {
  return refs.map(
    (row) =>
      `${row.creationId} — ${usageKindLabel(row.usageKind)} “${row.usageOwnerLabel}”`,
  );
}

/**
 * Strip dead Library IDs from timeline/composition/storyboard/cabinet fields.
 * Does not invent replacements; clears or filters the referencing slots.
 */
export function pruneMissingProjectReferences(
  project: StoredProject,
  missingIds: readonly string[],
): StoredProject {
  const missing = new Set(
    missingIds.map((id) => id.trim()).filter(Boolean),
  );
  if (missing.size === 0) return project;

  const timeline = normalizeStoredTimeline(project.timeline).map((clip) => {
    let next = clip;
    if (clip.assetId && missing.has(clip.assetId)) {
      next = { ...next, assetId: "" };
    }
    if (clip.slideshow) {
      const imageAssetIds = (clip.slideshow.imageAssetIds ?? []).filter(
        (id) => !missing.has(id),
      );
      const audioAssetId =
        clip.slideshow.audioAssetId && missing.has(clip.slideshow.audioAssetId)
          ? null
          : clip.slideshow.audioAssetId;
      next = {
        ...next,
        slideshow: {
          ...clip.slideshow,
          imageAssetIds,
          audioAssetId: audioAssetId ?? undefined,
        },
      };
    }
    if (clip.addAssetDraft) {
      let draft = clip.addAssetDraft;
      let changed = false;
      if (
        draft.startFrameAssetId &&
        missing.has(draft.startFrameAssetId)
      ) {
        draft = { ...draft, startFrameAssetId: undefined };
        changed = true;
      }
      if (
        draft.firstFrameSource?.kind === "asset" &&
        missing.has(draft.firstFrameSource.assetId)
      ) {
        draft = { ...draft, firstFrameSource: undefined, startFrameAssetId: undefined };
        changed = true;
      }
      if (
        draft.lastFrameSource?.kind === "asset" &&
        missing.has(draft.lastFrameSource.assetId)
      ) {
        draft = { ...draft, lastFrameSource: undefined };
        changed = true;
      }
      if (changed) {
        next = { ...next, addAssetDraft: draft };
      }
    }
    if (clip.addAssetGeneration) {
      const gen = clip.addAssetGeneration;
      let startFrameAssetId =
        gen.startFrameAssetId && missing.has(gen.startFrameAssetId)
          ? undefined
          : gen.startFrameAssetId;
      let firstFrameSource = gen.firstFrameSource;
      if (
        firstFrameSource?.kind === "asset" &&
        missing.has(firstFrameSource.assetId)
      ) {
        firstFrameSource = undefined;
        startFrameAssetId = undefined;
      }
      let lastFrameSource = gen.lastFrameSource;
      if (
        lastFrameSource?.kind === "asset" &&
        missing.has(lastFrameSource.assetId)
      ) {
        lastFrameSource = undefined;
      }
      const creationId =
        gen.creationId && missing.has(gen.creationId) ? undefined : gen.creationId;
      if (!creationId) {
        next = { ...next, addAssetGeneration: undefined };
      } else if (
        startFrameAssetId !== gen.startFrameAssetId ||
        firstFrameSource !== gen.firstFrameSource ||
        lastFrameSource !== gen.lastFrameSource ||
        creationId !== gen.creationId
      ) {
        next = {
          ...next,
          addAssetGeneration: {
            ...gen,
            startFrameAssetId,
            firstFrameSource,
            lastFrameSource,
            creationId,
          },
        };
      }
    }
    return next;
  });

  const stillWorkstreams = normalizeStillWorkstreams(project.stillWorkstreams).map(
    (stream) => ({
      ...stream,
      memberIds: stream.memberIds.filter((id) => !missing.has(id)),
      nodes: stream.nodes.map((node) =>
        node.creationId && missing.has(node.creationId)
          ? { ...node, creationId: null }
          : node,
      ),
    }),
  );

  let storyboardProposal = project.storyboardProposal ?? null;
  if (storyboardProposal) {
    let next = storyboardProposal;
    if (
      next.sourceAudioCreationId &&
      missing.has(next.sourceAudioCreationId)
    ) {
      next = { ...next, sourceAudioCreationId: "" };
    }
    if (next.generationPlan?.steps) {
      next = {
        ...next,
        generationPlan: {
          ...next.generationPlan,
          steps: next.generationPlan.steps.map((step) => {
            let patched = step;
            if (step.creationId && missing.has(step.creationId)) {
              patched = { ...patched, creationId: undefined };
            }
            if (
              step.stillSource?.mode === "project_image" &&
              step.stillSource.creationId &&
              missing.has(step.stillSource.creationId)
            ) {
              patched = {
                ...patched,
                stillSource: {
                  ...step.stillSource,
                  creationId: "",
                },
              };
            }
            return patched;
          }),
        },
      };
    }
    storyboardProposal = next;
  }

  return {
    ...project,
    timeline,
    stillWorkstreams,
    creationIds: project.creationIds.filter((id) => !missing.has(id)),
    mainAudioCreationId:
      project.mainAudioCreationId && missing.has(project.mainAudioCreationId)
        ? null
        : project.mainAudioCreationId,
    lyricAlignment:
      project.lyricAlignment?.sourceAudioCreationId &&
      missing.has(project.lyricAlignment.sourceAudioCreationId)
        ? {
            ...project.lyricAlignment,
            sourceAudioCreationId: "",
          }
        : project.lyricAlignment,
    storyboardProposal,
    imagesGroupId:
      project.imagesGroupId && missing.has(project.imagesGroupId)
        ? null
        : project.imagesGroupId,
    videosGroupId:
      project.videosGroupId && missing.has(project.videosGroupId)
        ? null
        : project.videosGroupId,
  };
}
