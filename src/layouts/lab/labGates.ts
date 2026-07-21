import type { LabModuleId } from "./labTypes";

export type LabGateAction = "groups" | "settings" | "mvConcept";

export type LabGate = {
  reason: string;
  /** Short nav blurb when blocked */
  navBlurb: string;
  action?: LabGateAction;
};

export type LabGateContext = {
  groupsReady: boolean;
  assetCount: number;
  audioCount: number;
  imageCount: number;
  videoCount: number;
  openAiReady: boolean;
  /** FFmpeg on PATH / Homebrew — slice, extend, thumbs, etc. */
  ffmpegReady: boolean;
  /** Demucs CLI — vocals isolate + a2v stems. */
  demucsReady: boolean;
  /** Whisper CLI — local transcription for lyric align. */
  whisperReady: boolean;
  /** Vocals slice prepared in Vocals / slice (required for a2v). */
  vocalsSliceReady: boolean;
  /** Lyric align has at least one sung timed line. */
  hasAlignedSungLines: boolean;
  hasLockedStoryboardConcept: boolean;
  hasStoryboardBudget: boolean;
};

/** Prerequisites for each Lab tool — null means the module can run. */
export function labModuleGate(
  id: LabModuleId,
  ctx: LabGateContext,
): LabGate | null {
  const needsGroups =
    id === "create" || id === "mutate" || id === "a2v" || id === "frame";
  if (needsGroups && !ctx.groupsReady) {
    return {
      navBlurb: "Requires Project groups first",
      reason:
        "This step files into the project Images / Videos groups. Run Project groups first (or again after Delete / clean up).",
      action: "groups",
    };
  }

  if (id === "seeds" && ctx.assetCount === 0) {
    return {
      navBlurb: "Add project assets first",
      reason:
        "Add creations to this project from Library, then inspect seed URLs here.",
    };
  }

  if (id === "isolate" && ctx.audioCount === 0) {
    return {
      navBlurb: "Requires project audio",
      reason:
        "Add audio to this project and sync/download it locally before isolating or slicing.",
    };
  }

  if (
    (id === "isolate" || id === "a2v" || id === "extend" || id === "frame") &&
    !ctx.ffmpegReady
  ) {
    return {
      navBlurb: "Requires FFmpeg",
      reason:
        "FFmpeg is not available. Install it (brew install ffmpeg), then re-check under Settings → Local tools. See LOCAL_TOOLS.md.",
      action: "settings",
    };
  }

  if (id === "a2v" && !ctx.demucsReady) {
    return {
      navBlurb: "Requires Demucs",
      reason:
        "Demucs is not installed (or not on PATH). Install it from Settings → Local tools, or see LOCAL_TOOLS.md. a2v needs a vocals stem.",
      action: "settings",
    };
  }

  if (id === "a2v") {
    if (ctx.imageCount === 0) {
      return {
        navBlurb: "Requires a project image",
        reason:
          "Add an image to this project (with a cloud URL) to use as the a2v still.",
      };
    }
    if (!ctx.vocalsSliceReady) {
      return {
        navBlurb: "Requires vocals slice",
        reason:
          "Run Vocals / slice first: separate full vocals, pick a range on the vocals waveform, and slice it. a2v uses that clip.",
      };
    }
  }

  if ((id === "extend" || id === "frame") && ctx.videoCount === 0) {
    return {
      navBlurb: "Requires a project video",
      reason:
        id === "frame"
          ? "Add a video to this project and sync/download it locally before pulling a frame."
          : "Add a video to this project and sync/download it locally before clip extend.",
    };
  }

  if (id === "mutate" && ctx.imageCount === 0) {
    return {
      navBlurb: "Requires a project image",
      reason:
        "Add an image to this project (with a cloud URL) before image mutate.",
    };
  }

  const needsOpenAi =
    id === "openai" ||
    id === "align" ||
    id === "mvConcept" ||
    id === "mvBudget" ||
    id === "mvScenes";
  if (needsOpenAi && !ctx.openAiReady) {
    return {
      navBlurb: "Requires OpenAI API key",
      reason:
        "An OpenAI API key is required. Set it in Settings from the account menu (upper right).",
      action: "settings",
    };
  }

  if (id === "align" && ctx.audioCount === 0) {
    return {
      navBlurb: "Requires project audio",
      reason:
        "Add audio to this project and sync/download it locally before lyric align.",
    };
  }

  if (id === "align" && !ctx.demucsReady) {
    return {
      navBlurb: "Requires Demucs",
      reason:
        "Demucs is required to use the full vocals stem from Vocals / slice. Install from Settings → Local tools.",
      action: "settings",
    };
  }

  if (id === "mvConcept" && !ctx.hasAlignedSungLines) {
    return {
      navBlurb: "Requires lyric align",
      reason:
        "Run Lyric align first — MV Concept needs timed lyric blocks on the main song.",
    };
  }

  if (id === "mvBudget" && !ctx.hasLockedStoryboardConcept) {
    return {
      navBlurb: "Requires MV Concept",
      reason:
        "Run MV Concept first and lock a creative direction.",
      action: "mvConcept",
    };
  }

  if (id === "mvScenes" && !ctx.hasStoryboardBudget) {
    return {
      navBlurb: "Requires MV Budget",
      reason: "Run MV Budget first and plan a generation budget.",
    };
  }

  return null;
}
