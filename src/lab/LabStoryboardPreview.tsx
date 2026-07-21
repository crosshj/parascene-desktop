import { useMemo, type CSSProperties } from "react";
import type {
  AlignedLyricLine,
  ProposedScene,
  ProjectAspectRatio,
  StoryboardProposal,
  StoryboardShotType,
} from "../project/types";
import { projectAspectCss, PROJECT_ASPECT_OPTIONS } from "../project/aspectRatios";
import {
  STORYBOARD_SHOT_DESCRIPTIONS,
  type StoryboardShotType as ShotType,
} from "./storyboardShotCatalog";

import {
  visualGroupGlowColor,
  visualGroupIndex,
  visualGroupSwatchColor,
} from "./storyboardVisualGroups";

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function shotMotionClass(shotType: StoryboardShotType): string {
  switch (shotType) {
    case "push_in":
      return "motion-push-in";
    case "lip_sync_cu":
    case "lip_sync_mcu":
      return "motion-lip-sync";
    case "chorus_punch":
      return "motion-punch";
    case "wide_performance":
    case "location_plate":
      return "motion-pan";
    case "lyric_card":
      return "motion-lyric-card";
    case "bridge_reset":
      return "motion-reset";
    case "outro_hold":
      return "motion-fade-out";
    case "crowd_energy":
      return "motion-shake";
    default:
      return "motion-static";
  }
}

function activeLyricLine(
  lines: AlignedLyricLine[] | undefined,
  sec: number,
): string | null {
  if (!lines?.length) return null;
  const hit = lines.find((line) => sec >= line.startSec && sec < line.endSec);
  return hit?.line.trim() || null;
}

function previewFrameStyle(aspectRatio: ProjectAspectRatio): CSSProperties {
  const opt =
    PROJECT_ASPECT_OPTIONS.find((o) => o.id === aspectRatio) ??
    PROJECT_ASPECT_OPTIONS[3];
  return {
    aspectRatio: projectAspectCss(aspectRatio),
    ["--preview-ar-w" as string]: String(opt.w),
    ["--preview-ar-h" as string]: String(opt.h),
  };
}

function sceneAtTime(
  scenes: ProposedScene[],
  sec: number,
): { scene: ProposedScene; index: number } | null {
  if (!scenes.length) return null;
  const index = scenes.findIndex(
    (scene) => sec >= scene.startSec && sec < scene.endSec,
  );
  if (index >= 0) return { scene: scenes[index], index };
  const last = scenes[scenes.length - 1];
  if (sec >= last.endSec) {
    return { scene: last, index: scenes.length - 1 };
  }
  return null;
}

export function LabStoryboardPreview(props: {
  proposal: StoryboardProposal;
  currentSec: number;
  playing: boolean;
  lyricLines?: AlignedLyricLine[];
}) {
  const { proposal, currentSec, playing, lyricLines } = props;
  const aspectRatio = proposal.aspectRatio as ProjectAspectRatio;
  const hit = sceneAtTime(proposal.scenes, currentSec);
  const activeScene = hit?.scene ?? null;
  const sceneIndex = hit?.index ?? -1;

  const visual = activeScene
    ? (() => {
        const index = visualGroupIndex(
          proposal.visualGroups,
          activeScene.visualGroupId,
        );
        const group = proposal.visualGroups.find(
          (g) => g.id === activeScene.visualGroupId,
        );
        const swatch = visualGroupSwatchColor(index);
        return {
          fill: swatch,
          glow: visualGroupGlowColor(index),
          label: group?.label ?? "Visual group",
        };
      })()
    : null;

  const sceneDuration = activeScene
    ? Math.max(0.1, activeScene.endSec - activeScene.startSec)
    : 1;
  const sceneElapsed = activeScene
    ? Math.max(0, currentSec - activeScene.startSec)
    : 0;

  const lyric = activeLyricLine(lyricLines, currentSec);
  const shotDescription = activeScene
    ? STORYBOARD_SHOT_DESCRIPTIONS[activeScene.shotType as ShotType] ??
      activeScene.shotType.replace(/_/g, " ")
    : "";

  const motionClass = activeScene
    ? shotMotionClass(activeScene.shotType)
    : "motion-static";
  const motionStyle = useMemo(() => {
    const looping =
      motionClass === "motion-lip-sync" ||
      motionClass === "motion-punch" ||
      motionClass === "motion-shake";
    return {
      animationDuration: looping ? "2.4s" : `${sceneDuration}s`,
      animationPlayState: playing ? ("running" as const) : ("paused" as const),
    };
  }, [motionClass, sceneDuration, playing]);

  const aspectStyle = previewFrameStyle(aspectRatio);

  if (!activeScene || !visual) {
    return (
      <div className="lab-storyboard-preview-wrap">
        <div
          className="lab-storyboard-preview is-empty"
          style={aspectStyle}
        >
          <p className="muted">Press play to preview the storyboard in motion.</p>
        </div>
      </div>
    );
  }

  const isLyricCard = activeScene.shotType === "lyric_card";
  const isLipSync =
    activeScene.shotType === "lip_sync_cu" ||
    activeScene.shotType === "lip_sync_mcu";

  return (
    <div className="lab-storyboard-preview-wrap">
      <div
        className={[
          "lab-storyboard-preview",
          motionClass,
          playing ? "is-playing" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={aspectStyle}
        aria-label="Storyboard preview"
      >
        <div
          className="lab-storyboard-preview-bg"
          style={{
            background: `radial-gradient(ellipse at 50% 35%, ${visual.glow}, transparent 70%), linear-gradient(160deg, #0a0a12 0%, #111827 45%, #0f172a 100%)`,
          }}
        />
        <div
          className="lab-storyboard-preview-accent"
          style={{ backgroundColor: visual.fill }}
        />

        <div
          key={activeScene.id}
          className="lab-storyboard-preview-stage"
          style={motionStyle}
        >
          {isLipSync ? (
            <div className="lab-storyboard-preview-performer" aria-hidden>
              <span className="lab-storyboard-preview-performer-head" />
              <span className="lab-storyboard-preview-performer-body" />
            </div>
          ) : null}

          {isLyricCard && lyric ? (
            <p className="lab-storyboard-preview-lyric-card">{lyric}</p>
          ) : null}
        </div>

        <div className="lab-storyboard-preview-overlay">
          <div className="lab-storyboard-preview-top">
            <span className="lab-storyboard-preview-scene-index">
              Scene {sceneIndex + 1} / {proposal.scenes.length}
            </span>
            <span className="lab-storyboard-preview-time">
              {formatClock(currentSec)} · {formatClock(sceneElapsed)} in scene
            </span>
          </div>

          <div className="lab-storyboard-preview-body">
            <span className="lab-storyboard-preview-shot">{shotDescription}</span>
            {activeScene.title ? (
              <h3 className="lab-storyboard-preview-title">{activeScene.title}</h3>
            ) : null}
            {!isLyricCard ? (
              <p className="lab-storyboard-preview-note">{activeScene.note}</p>
            ) : null}
            {activeScene.promptHint ? (
              <p className="lab-storyboard-preview-hint">{activeScene.promptHint}</p>
            ) : null}
            {lyric && !isLyricCard ? (
              <p className="lab-storyboard-preview-lyric">“{lyric}”</p>
            ) : null}
          </div>

          <div className="lab-storyboard-preview-footer">
            <span className="lab-storyboard-preview-group">{visual.label}</span>
            <span className="lab-storyboard-preview-method">
              {activeScene.productionMethod ?? activeScene.shotType}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
