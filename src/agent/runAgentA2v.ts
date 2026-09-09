import { convertFileSrc } from "@tauri-apps/api/core";
import { getCreation, importProjectAssetPaths } from "../library/catalogClient";
import { groupSourceCreationIds } from "../library/creationFlags";
import { parascenePublicImageUrl } from "../library/previewUrl";
import type { Creation } from "../library/types";
import { audioWaveformPeaks } from "../lab/audioTools";
import { runAddAssetGeneration } from "../layouts/editor/addAssetGenerate";
import { requestApplyEditorSelection } from "../layouts/editor/editorSelection";
import {
  clampAddAssetDurationSec,
  formatStagedDuration,
} from "../layouts/editor/stagedClip";
import type { StartFramePreview } from "../layouts/editor/addAssetStartFrame";
import { identifyDesktopCabinet } from "../project/desktopProjectGroups";
import { flushProjectStore } from "../project/projectStore";
import type { TimelineClip } from "../project/types";
import type { useShellOptional } from "../app/ShellProvider";

type Shell = NonNullable<ReturnType<typeof useShellOptional>>;

/** Videos + Videos cabinet members to drop from the project (Library keeps them). */
export async function leftoverVideoIdsToHide(opts: {
  creationIds: readonly string[];
  videosGroupId?: string | null;
  keepIds: Iterable<string>;
  lookup: (id: string) => Promise<Creation | null>;
}): Promise<string[]> {
  const keep = new Set(
    [...opts.keepIds].map((id) => String(id).trim()).filter(Boolean),
  );
  const hide = new Set<string>();
  const add = (raw: string) => {
    const id = raw.trim();
    if (id && !keep.has(id)) hide.add(id);
  };

  const considerCabinet = async (id: string) => {
    add(id);
    const row = await opts.lookup(id);
    if (!row) return;
    for (const mid of groupSourceCreationIds(row)) add(mid);
  };

  const vg = opts.videosGroupId?.trim() ?? "";
  if (vg) await considerCabinet(vg);

  for (const raw of opts.creationIds) {
    const id = String(raw).trim();
    if (!id || keep.has(id) || hide.has(id)) continue;
    const row = await opts.lookup(id);
    if (!row) continue;
    if (identifyDesktopCabinet(row)?.role === "project_videos") {
      await considerCabinet(id);
      continue;
    }
    if (String(row.mediaType).trim().toLowerCase() === "video") add(id);
  }

  return [...hide];
}

async function hideLeftoverProjectVideos(
  shell: Shell,
  keepIds: Iterable<string>,
): Promise<void> {
  const hide = await leftoverVideoIdsToHide({
    creationIds: (shell.project?.assets ?? []).map((asset) => asset.id),
    videosGroupId: shell.project?.videosGroupId,
    keepIds,
    lookup: getCreation,
  });
  if (hide.length > 0) {
    try {
      await shell.removeCreationsFromOpenProject(hide);
    } catch {
      // Native membership throws on Videos cabinets / the last video.
      shell.removeCreationsFromOpenProjectLocal(hide);
    }
  }
  if (shell.project?.videosGroupId) {
    shell.setOpenProjectGroupIds({ videosGroupId: null });
  }
  await flushProjectStore();
}

/** Persist timeline/selection. Remount only when Editor must rebuild (form / clip). */
export async function settleEditorForHelpShot(
  shell: Shell,
  remount = false,
): Promise<void> {
  shell.setOpenProjectTimelineMonitorActive(false);
  await flushProjectStore();
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  requestApplyEditorSelection();
  if (remount) {
    if (shell.mode === "editor") {
      shell.setMode("director");
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    shell.setMode("editor");
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    requestApplyEditorSelection();
  } else {
    await new Promise((resolve) => window.setTimeout(resolve, 400));
  }
}

function newClipId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function waitForLocalPath(id: string, timeoutMs: number): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await getCreation(id);
    const path = row?.localPath?.trim();
    if (path) return path;
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  return null;
}

function startFrameFromStill(still: Creation): StartFramePreview {
  const path = still.localPath?.trim() || null;
  let previewUrl: string | null = null;
  if (path) {
    try {
      previewUrl = convertFileSrc(path);
    } catch {
      previewUrl = null;
    }
  }
  return {
    previewUrl,
    note: "Start frame",
    framePath: path,
    frameTimeSec: 0,
    framing: "fit",
    sourceAssetId: still.id,
    sourceIsImage: true,
    remoteImageUrl: parascenePublicImageUrl(still),
  };
}

export async function runAgentA2v(opts: {
  shell: Shell;
  projectId: string;
  stillId: string;
  audioId?: string;
  audioPath?: string;
  prompt: string;
  durationSec?: number;
  generate?: boolean;
  /** With generate: false, show the filled A2V form on a 9s placeholder clip. */
  form?: boolean;
  videoId?: string;
}): Promise<{
  creationId: string;
  stillId: string;
  audioId: string;
  audioDurationSec: number;
  clipDurationSec: number;
  localPath: string | null;
  videosGroupId: string | null;
  model: string;
  staged: boolean;
}> {
  const { shell, projectId } = opts;
  let audioId = opts.audioId?.trim() || "";
  if (!audioId) {
    const audioPath = opts.audioPath?.trim();
    if (!audioPath) throw new Error("generation.a2v needs audioId or audioPath");
    const imported = await importProjectAssetPaths(projectId, [audioPath]);
    audioId = imported.creations[0]?.id?.trim() || "";
    if (!audioId) throw new Error("Could not import audio for A2V");
  }

  const videoId = opts.videoId?.trim() || "";
  const showForm = opts.form === true && opts.generate !== true;
  if (opts.generate !== false && videoId) {
    throw new Error("generation.a2v videoId is only valid with generate: false");
  }
  if (showForm && videoId) {
    throw new Error("generation.a2v form is only valid without videoId");
  }
  await shell.addCreationsToProject(
    projectId,
    [opts.stillId, audioId, videoId].filter(Boolean),
  );
  await new Promise((resolve) => window.setTimeout(resolve, 200));
  if (!videoId) {
    await hideLeftoverProjectVideos(shell, [opts.stillId, audioId]);
  }

  const [still, audio, finished] = await Promise.all([
    getCreation(opts.stillId),
    getCreation(audioId),
    videoId ? getCreation(videoId) : Promise.resolve(null),
  ]);
  if (!still) throw new Error("Start still was not found in Library");
  if (!audio) throw new Error("Timeline audio was not found in Library");
  if (videoId && !finished) throw new Error("Finished clip was not found in Library");

  const durationSec = clampAddAssetDurationSec(opts.durationSec ?? 9);
  const audioPath = audio.localPath?.trim();
  if (!audioPath) throw new Error("Timeline audio is not on disk");
  const { durationSec: probedAudioSec } = await audioWaveformPeaks(audioPath, 16);
  const audioDurationSec =
    Number.isFinite(probedAudioSec) && probedAudioSec > 0
      ? probedAudioSec
      : durationSec;
  const audioClipId = newClipId();
  const videoClipId = newClipId();
  const audioClip: TimelineClip = {
    id: audioClipId,
    label: formatStagedDuration(audioDurationSec),
    startSec: 0,
    endSec: audioDurationSec,
    assetId: audioId,
    thumbUrl: null,
    lane: "audio",
    kind: "audio",
    inSec: 0,
    outSec: audioDurationSec,
  };
  const videoClip: TimelineClip = finished
    ? {
        id: videoClipId,
        label: `${durationSec.toFixed(1)}s`,
        startSec: 0,
        endSec: durationSec,
        assetId: videoId,
        thumbUrl: null,
        lane: "video",
        kind: "video",
        inSec: 0,
        outSec: durationSec,
        includeAudio: false,
      }
    : {
        id: videoClipId,
        label: `${durationSec.toFixed(1)}s`,
        startSec: 0,
        endSec: durationSec,
        thumbUrl: null,
        lane: "video",
        kind: "video",
        isAddAssetPlaceholder: true,
        addAssetDraft: {
          prompt: opts.prompt,
          audioMode: "full_mix",
          continuityMode: "start_frame",
          blueModel: "ltx_a2v",
          intentId: "image_audio_to_video",
          server: "parascene_blue",
          startFrameAssetId: opts.stillId,
        },
      };

  // generate: false without form/videoId is audio-only — Help's "speech on
  // the timeline" shot must not already show a video clip.
  if (opts.generate === false && !showForm && !finished) {
    shell.setOpenProjectTimeline([audioClip]);
    shell.setOpenProjectMainAudioCreationId(audioId);
    // Select the still (not the audio clip) so preview is the goblin, V1 empty.
    shell.setOpenProjectSelectedTimelineClipId(null);
    shell.setOpenProjectSelectedAssetId(opts.stillId);
    await settleEditorForHelpShot(shell);
    return {
      creationId: "",
      stillId: opts.stillId,
      audioId,
      audioDurationSec,
      clipDurationSec: durationSec,
      localPath: null,
      videosGroupId: null,
      model: "ltx_a2v",
      staged: true,
    };
  }

  shell.setOpenProjectTimeline([videoClip, audioClip]);
  shell.setOpenProjectMainAudioCreationId(audioId);
  shell.setOpenProjectSelectedTimelineClipId(videoClipId);
  shell.setOpenProjectSelectedAssetId(null);
  if (opts.generate === false) {
    await settleEditorForHelpShot(shell, true);
    return {
      creationId: videoId,
      stillId: opts.stillId,
      audioId,
      audioDurationSec,
      clipDurationSec: durationSec,
      localPath: finished?.localPath ?? null,
      videosGroupId: null,
      model: "ltx_a2v",
      staged: true,
    };
  }

  const placeholder = videoClip;
  const startFrame = startFrameFromStill(still);
  const result = await runAddAssetGeneration({
    placeholder,
    timeline: [placeholder, audioClip],
    mainAudioCreationId: audioId,
    lyricAlignment: null,
    aspectRatio: shell.project?.aspectRatio ?? "16:9",
    projectId,
    projectTitle: shell.project?.title ?? "Untitled project",
    imagesGroupId: shell.project?.imagesGroupId ?? null,
    videosGroupId: shell.project?.videosGroupId ?? null,
    prompt: opts.prompt,
    lyricsText: "",
    audioMode: "full_mix",
    continuityMode: "start_frame",
    blueModel: "ltx_a2v",
    startFrame,
    onSteps: () => {},
    onProgress: () => {},
  });

  if (result.creationId) {
    await shell.addCreationsToProject(projectId, [result.creationId]);
  }
  const finishedClip: TimelineClip = {
    id: videoClipId,
    label: `${durationSec.toFixed(1)}s`,
    startSec: 0,
    endSec: durationSec,
    assetId: result.creationId,
    thumbUrl: null,
    lane: "video",
    kind: "video",
    inSec: 0,
    outSec: durationSec,
    includeAudio: false,
  };
  shell.setOpenProjectTimeline([finishedClip, audioClip]);
  shell.setOpenProjectSelectedTimelineClipId(videoClipId);
  shell.setOpenProjectSelectedAssetId(null);
  window.dispatchEvent(new CustomEvent("parascene-library-reload"));
  await settleEditorForHelpShot(shell, true);

  const localPath = result.creationId
    ? await waitForLocalPath(result.creationId, 60_000)
    : null;

  return {
    creationId: result.creationId,
    stillId: opts.stillId,
    audioId,
    audioDurationSec,
    clipDurationSec: durationSec,
    localPath,
    videosGroupId: result.videosGroupId,
    model: result.model,
    staged: false,
  };
}
