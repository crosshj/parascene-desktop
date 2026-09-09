import { cacheMissingMedia, getCreation } from "../library/catalogClient";
import { audioWaveformPeaks } from "../lab/audioTools";
import { requestOpenNewAsset } from "../layouts/editor/addAssetEvents";
import { formatStagedDuration } from "../layouts/editor/stagedClip";
import { clipAudioTrack } from "../project/audioTrack";
import { flushProjectStore } from "../project/projectStore";
import type { TimelineClip } from "../project/types";
import { runLabParasceneGenerate } from "../services/labParasceneGenerate";
import type { useShellOptional } from "../app/ShellProvider";
import { settleEditorForHelpShot, waitForLocalPath } from "./runAgentA2v";

type Shell = NonNullable<ReturnType<typeof useShellOptional>>;

function newClipId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function nextAudioStartSec(
  clips: readonly TimelineClip[],
  audioTrack: 1 | 2,
): number {
  const ends = clips
    .filter((clip) => clip.lane === "audio" && clipAudioTrack(clip) === audioTrack)
    .map((clip) => clip.endSec);
  return ends.length ? Math.max(...ends) : 0;
}

export async function runAgentAudio(opts: {
  shell: Shell;
  projectId: string;
  intent: "text_to_speech" | "text_to_music";
  prompt: string;
  model: string;
  voice?: string;
  generate?: boolean;
}): Promise<{
  creationId: string;
  projectId: string;
  intent: "text_to_speech" | "text_to_music";
  model: string;
  voice: string | null;
  localPath: string | null;
  staged: boolean;
}> {
  const { shell, projectId } = opts;
  requestOpenNewAsset({
    intent: opts.intent,
    prompt: opts.prompt,
    model: opts.model,
    voice: opts.voice,
  });
  await sleep(700);

  if (opts.generate === false) {
    return {
      creationId: "",
      projectId,
      intent: opts.intent,
      model: opts.model,
      voice: opts.voice?.trim() || null,
      localPath: null,
      staged: true,
    };
  }

  const model = opts.model.trim();
  if (/voice-cloning|voice_train|voicetrain|replicatevoicetrain/i.test(model)) {
    throw new Error("generation.audio refuses voice train / voice cloning");
  }

  const args: Record<string, unknown> = {
    prompt: opts.prompt,
    model,
  };
  const voice = opts.voice?.trim();
  if (voice) args.voice = voice;

  const result = await runLabParasceneGenerate({
    projectId,
    projectTitle: shell.project?.title ?? "Untitled project",
    imagesGroupId: shell.project?.imagesGroupId,
    videosGroupId: shell.project?.videosGroupId,
    serverId: 1,
    method: opts.intent === "text_to_music" ? "replicateMusic" : "replicateSpeech",
    args,
    mediaType: "audio",
    intent: opts.intent,
    label: model,
  });

  if (result.creationId) {
    await shell.addCreationsToProject(projectId, [result.creationId]);
    window.dispatchEvent(
      new CustomEvent("parascene-library-asset-selected", {
        detail: { assetId: result.creationId },
      }),
    );
  }
  window.dispatchEvent(new CustomEvent("parascene-library-reload"));
  await settleEditorForHelpShot(shell);

  let localPath = result.creationId
    ? await waitForLocalPath(result.creationId, 60_000, "audio")
    : null;

  if (result.creationId && !localPath) {
    // Generate files the catalog row; Sync media is how a person pulls the file.
    shell.setPrimaryTab("library");
    shell.setLibrarySurface("sync");
    await sleep(400);
    await cacheMissingMedia();
    localPath = await waitForLocalPath(result.creationId, 180_000, "audio");
    shell.setPrimaryTab("project");
    shell.setMode("editor");
    await settleEditorForHelpShot(shell);
  }

  if (result.creationId && !localPath) {
    const row = await getCreation(result.creationId).catch(() => null);
    throw new Error(
      `generation.audio finished ${result.creationId} without a local file` +
        ` (downloadState=${row?.downloadState ?? "missing"},` +
        ` remoteUrl=${row?.remoteUrl ?? "none"})`,
    );
  }

  return {
    creationId: result.creationId,
    projectId,
    intent: opts.intent,
    model: opts.model,
    voice: voice || null,
    localPath,
    staged: false,
  };
}

export async function runAgentTimelinePlace(opts: {
  shell: Shell;
  projectId: string;
  assetId: string;
  audioTrack?: 1 | 2;
  startSec?: number;
}): Promise<{
  clipId: string;
  assetId: string;
  audioTrack: 1 | 2;
  startSec: number;
  endSec: number;
}> {
  const { shell, projectId } = opts;
  const assetId = opts.assetId.trim();
  if (!assetId) throw new Error("timeline.place needs assetId");
  await shell.addCreationsToProject(projectId, [assetId]);
  const creation = await getCreation(assetId);
  const audioPath = creation.localPath?.trim();
  if (!audioPath) throw new Error("timeline.place needs audio on disk");
  const { durationSec: probed } = await audioWaveformPeaks(audioPath, 16);
  const durationSec =
    Number.isFinite(probed) && probed > 0 ? probed : 2;
  const audioTrack = opts.audioTrack === 2 ? 2 : 1;
  if (audioTrack === 2) {
    shell.setOpenProjectEditorAudio2(true);
  }
  const existing = shell.project?.timeline ?? [];
  const startSec =
    typeof opts.startSec === "number" && Number.isFinite(opts.startSec)
      ? Math.max(0, opts.startSec)
      : nextAudioStartSec(existing, audioTrack);
  const endSec = startSec + durationSec;
  const clipId = newClipId();
  const clip: TimelineClip = {
    id: clipId,
    label: formatStagedDuration(durationSec),
    startSec,
    endSec,
    assetId,
    thumbUrl: null,
    lane: "audio",
    kind: "audio",
    inSec: 0,
    outSec: durationSec,
    audioTrack: audioTrack === 2 ? 2 : undefined,
  };
  shell.setOpenProjectTimeline([...existing, clip]);
  shell.setOpenProjectSelectedTimelineClipId(clipId);
  shell.setOpenProjectSelectedAssetId(null);
  await flushProjectStore();
  await settleEditorForHelpShot(shell);
  return {
    clipId,
    assetId,
    audioTrack,
    startSec,
    endSec,
  };
}
