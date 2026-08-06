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
      clip.addAssetGeneration?.startFrameAssetId,
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
