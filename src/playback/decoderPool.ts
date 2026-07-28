import type { BakeInfo } from "../library/slideshowMedia";
import { mediaUrlForBakePath } from "../library/slideshowMedia";
import {
  framingClassName,
  framingViewportStyle,
  normalizeFraming,
  videoStretchStyle,
  type StagedClipFraming,
} from "../layouts/editor/stagedClip";
import {
  clipInSec,
  clipSpeed,
  peekNextVisualClip,
  resolveTimelineFrame,
  type TimelineLayer,
} from "../layouts/editor/timelineCompose";
import type { TimelineClip } from "../project/types";
import {
  assetDecoderKey,
  assetIdFromKey,
  isReverseKey,
  isSlideshowKey,
  listVisualDecoders,
  parkSourceByKey,
  type AssetDecoderKey,
  type VisualDecoderMeta,
} from "./assetDecoders";
import type { MediaSources } from "./mediaSources";
import {
  alignToSourceSec,
  seekMedia,
  waitForCanPlay,
  waitForPaintedFrame,
} from "./seekMedia";

export type DecoderPoolOptions = {
  surface: HTMLElement;
  mediaSources: MediaSources;
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
};

type SlotKind = "video" | "image" | "slideshow" | "extend";

type DecoderSlot = {
  key: AssetDecoderKey;
  meta: VisualDecoderMeta;
  kind: SlotKind;
  viewport: HTMLDivElement;
  media: HTMLVideoElement | HTMLImageElement;
  warm: boolean;
  paintedFraming: StagedClipFraming;
  src: string | null;
  stretchCleanup: (() => void) | null;
  /** Cancels in-flight align / park work. */
  workGen: number;
  /** Last clip id we activated while playing (cut detection). */
  lastPlayClipId: string | null;
  /** Last standby park target — avoid re-seeking every tick. */
  lastParkSec: number | null;
};

type AudioSlot = {
  assetId: string;
  reverse: boolean;
  el: HTMLAudioElement;
  workGen: number;
  lastPlayClipId: string | null;
  lastSeekEpoch: number;
};

function slotKindFromMeta(meta: VisualDecoderMeta): SlotKind {
  if (meta.extendBakePath) return "extend";
  if (meta.kind === "slideshow") return "slideshow";
  if (meta.kind === "image") return "image";
  return "video";
}

function bakeUrl(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  try {
    return mediaUrlForBakePath(trimmed);
  } catch {
    return null;
  }
}

function applyViewportStyle(
  viewport: HTMLDivElement,
  framing: StagedClipFraming,
  stageW: number,
  stageH: number,
  matteW: number,
  matteH: number,
): void {
  const style = framingViewportStyle(framing, stageW, stageH, matteW, matteH);
  viewport.className = `editor-preview-framing-viewport${
    style ? " is-project-matte" : ""
  }`;
  if (style) {
    viewport.style.width = `${style.width}px`;
    viewport.style.height = `${style.height}px`;
    viewport.style.left = `${style.left}px`;
    viewport.style.top = `${style.top}px`;
  } else {
    viewport.style.width = "";
    viewport.style.height = "";
    viewport.style.left = "";
    viewport.style.top = "";
  }
}

function applyMediaClass(
  media: HTMLElement,
  framing: StagedClipFraming,
  standby: boolean,
): void {
  media.className = `editor-preview-media editor-preview-detail ${framingClassName(
    framing,
  )}${standby ? " is-standby" : ""}`;
}

function applyStretchStyle(video: HTMLVideoElement, framing: StagedClipFraming): void {
  if (framing !== "stretch") {
    video.style.objectFit = "";
    video.style.transform = "";
    video.style.transformOrigin = "";
    return;
  }
  const next = videoStretchStyle(
    video.videoWidth,
    video.videoHeight,
    video.clientWidth,
    video.clientHeight,
  );
  if (!next) return;
  video.style.objectFit = next.objectFit;
  video.style.transform = next.transform;
  video.style.transformOrigin = next.transformOrigin;
}

function commandedSourceSec(
  kind: SlotKind,
  active: boolean,
  liveLayer: TimelineLayer | null,
  parkSec: number,
): number {
  if (!active) return parkSec;
  if (kind === "extend") {
    return (liveLayer?.localSec ?? 0) * clipSpeed(liveLayer?.clip ?? {});
  }
  return liveLayer?.sourceSec ?? 0;
}

function wantsClockSync(
  kind: SlotKind,
  liveLayer: TimelineLayer | null,
): boolean {
  if (kind === "slideshow" || kind === "extend") return true;
  if (kind !== "video" || !liveLayer) return false;
  return Math.abs(clipSpeed(liveLayer.clip) - 1) >= 0.001;
}

/**
 * Imperative decoder pool: one persistent element per asset×direction / bake,
 * with seek-then-show cut handoff.
 */
export type PlaybackDiagnostics = {
  warmKeys: string[];
  activeKey: string | null;
  visibleKey: string | null;
  lastCutLatencyMs: number | null;
  stallReason: string | null;
};

export type DecoderPool = {
  setStage(stageW: number, stageH: number, matteW: number, matteH: number): void;
  setBakeInfo(bakeInfoByClipId: ReadonlyMap<string, BakeInfo> | null): void;
  setVolume(volume: number): void;
  setMediaSeekEpoch(epoch: number): void;
  /** Reconcile slots + handoff for the current playhead / transport. */
  sync(
    clips: readonly TimelineClip[],
    currentSec: number,
    playing: boolean,
  ): void;
  getDiagnostics(): PlaybackDiagnostics;
  destroy(): void;
};

export function createDecoderPool(options: DecoderPoolOptions): DecoderPool {
  const { surface, mediaSources } = options;
  let stageW = options.stageW;
  let stageH = options.stageH;
  let matteW = options.matteW;
  let matteH = options.matteH;
  let bakeInfoByClipId: ReadonlyMap<string, BakeInfo> | null = null;
  let volume = 100;
  let mediaSeekEpoch = 0;
  let destroyed = false;

  const slots = new Map<AssetDecoderKey, DecoderSlot>();
  let visibleKey: AssetDecoderKey | null = null;
  let activeKey: AssetDecoderKey | null = null;
  let statusEl: HTMLSpanElement | null = null;
  let audioSlot: AudioSlot | null = null;
  let lastAudioKey: string | null = null;
  let lastCutStartedAt = 0;
  let lastCutLatencyMs: number | null = null;
  let stallReason: string | null = null;

  const setStatus = (message: string | null, wait = false) => {
    if (!message) {
      statusEl?.remove();
      statusEl = null;
      return;
    }
    if (!statusEl) {
      statusEl = document.createElement("span");
      surface.appendChild(statusEl);
    }
    statusEl.className = wait
      ? "editor-preview-wait muted"
      : "editor-preview-status muted";
    statusEl.textContent = message;
  };

  const markReady = (key: AssetDecoderKey) => {
    if (destroyed) return;
    if (activeKey === key) {
      const wasHidden = visibleKey !== key;
      visibleKey = key;
      stallReason = null;
      if (wasHidden && lastCutStartedAt > 0) {
        lastCutLatencyMs = performance.now() - lastCutStartedAt;
        lastCutStartedAt = 0;
      }
      // Re-apply visibility classes without a full resync.
      for (const slot of slots.values()) {
        const show =
          slot.key === visibleKey &&
          (slot.kind === "image" || slot.warm);
        applyMediaClass(slot.media, slot.paintedFraming, !show);
      }
    }
  };

  const attachStretchObserver = (slot: DecoderSlot) => {
    slot.stretchCleanup?.();
    slot.stretchCleanup = null;
    if (!(slot.media instanceof HTMLVideoElement)) return;
    const video = slot.media;
    const update = () => applyStretchStyle(video, slot.paintedFraming);
    video.addEventListener("loadedmetadata", update);
    const ro = new ResizeObserver(update);
    ro.observe(video);
    slot.stretchCleanup = () => {
      video.removeEventListener("loadedmetadata", update);
      ro.disconnect();
    };
    queueMicrotask(update);
  };

  const createSlot = (meta: VisualDecoderMeta): DecoderSlot => {
    const kind = slotKindFromMeta(meta);
    const viewport = document.createElement("div");
    surface.appendChild(viewport);

    let media: HTMLVideoElement | HTMLImageElement;
    if (kind === "image") {
      media = document.createElement("img");
      media.alt = "";
      media.draggable = false;
    } else {
      const video = document.createElement("video");
      video.playsInline = true;
      video.preload = "auto";
      video.muted = true;
      media = video;
    }
    viewport.appendChild(media);

    const slot: DecoderSlot = {
      key: meta.key,
      meta,
      kind,
      viewport,
      media,
      warm: false,
      paintedFraming: "fit",
      src: null,
      stretchCleanup: null,
      workGen: 0,
      lastPlayClipId: null,
      lastParkSec: null,
    };
    applyViewportStyle(viewport, "fit", stageW, stageH, matteW, matteH);
    applyMediaClass(media, "fit", true);
    if (media instanceof HTMLVideoElement) attachStretchObserver(slot);
    return slot;
  };

  const destroySlot = (slot: DecoderSlot) => {
    slot.workGen += 1;
    slot.stretchCleanup?.();
    slot.stretchCleanup = null;
    if (slot.media instanceof HTMLVideoElement) {
      slot.media.pause();
      slot.media.removeAttribute("src");
      slot.media.load();
    }
    slot.viewport.remove();
  };

  const resolveSrc = (
    slot: DecoderSlot,
    active: boolean,
  ): { src: string | null; status: string | null; wait: boolean } => {
    const { meta, kind } = slot;
    if (kind === "extend") {
      const bakePath = meta.extendBakePath ?? null;
      if (!bakePath) {
        if (!active) return { src: null, status: null, wait: false };
        const info =
          meta.clipId && bakeInfoByClipId
            ? bakeInfoByClipId.get(meta.clipId)
            : undefined;
        const status =
          info?.status === "generating"
            ? "Baking extend…"
            : info?.status === "failed"
              ? info.error?.trim() || "Extend bake failed"
              : "Hit Bake to render this extended clip";
        return { src: null, status, wait: false };
      }
      const src = bakeUrl(bakePath);
      if (!src && active) {
        return { src: null, status: "Extend bake unavailable", wait: false };
      }
      return { src, status: null, wait: false };
    }

    if (kind === "slideshow") {
      const bakePath = meta.bakePath ?? null;
      if (!bakePath) {
        if (!active) return { src: null, status: null, wait: false };
        const clipId = isSlideshowKey(meta.key)
          ? meta.key.split(":")[1] ?? null
          : null;
        const info =
          clipId && bakeInfoByClipId ? bakeInfoByClipId.get(clipId) : undefined;
        const status =
          info?.status === "generating"
            ? "Rendering slideshow…"
            : info?.status === "failed"
              ? info.error?.trim() || "Slideshow render failed"
              : "Hit Render to generate this slideshow";
        return { src: null, status, wait: false };
      }
      const src = bakeUrl(bakePath);
      if (!src && active) {
        return { src: null, status: "Slideshow bake unavailable", wait: false };
      }
      return { src, status: null, wait: false };
    }

    const assetId = assetIdFromKey(meta.key);
    mediaSources.ensureAsset(assetId);
    const reverse = isReverseKey(meta.key);
    const wantsReverse = reverse && kind === "video";
    if (wantsReverse) mediaSources.ensureReverse(assetId);

    const asset = mediaSources.getAsset(assetId);
    const reversed = wantsReverse
      ? mediaSources.getReverse(assetId)
      : null;

    if (kind === "video") {
      const src = wantsReverse ? reversed?.detail ?? null : asset.detail;
      if (active && wantsReverse && reversed?.busy) {
        return { src: null, status: "Loading reversed media…", wait: true };
      }
      if (active && wantsReverse && reversed?.needsBake) {
        return { src: null, status: "Hit Bake to reverse", wait: true };
      }
      if (active && wantsReverse && reversed?.error) {
        return { src: null, status: reversed.error, wait: false };
      }
      if (!src && active && asset.waitingLocal) {
        return { src: null, status: "Saving locally…", wait: true };
      }
      return { src, status: null, wait: false };
    }

    // image
    const src = asset.detail ?? asset.thumb;
    if (!src && active && asset.waitingLocal) {
      return { src: null, status: "Saving locally…", wait: true };
    }
    return { src, status: null, wait: false };
  };

  const setVideoSrc = (slot: DecoderSlot, src: string) => {
    const video = slot.media as HTMLVideoElement;
    if (slot.src === src) return false;
    slot.src = src;
    slot.warm = false;
    slot.workGen += 1;
    video.src = src;
    return true;
  };

  const setImageSrc = (slot: DecoderSlot, src: string) => {
    const img = slot.media as HTMLImageElement;
    if (slot.src === src) return false;
    slot.src = src;
    img.src = src;
    return true;
  };

  const alignVideo = async (
    slot: DecoderSlot,
    targetSec: number,
    opts: { playAfter: boolean; requirePaint: boolean },
  ): Promise<boolean> => {
    const gen = ++slot.workGen;
    const video = slot.media as HTMLVideoElement;
    const cancelled = () => destroyed || slot.workGen !== gen;

    const didSeek = await seekMedia(video, targetSec);
    if (cancelled()) return false;
    if (didSeek && opts.requirePaint) {
      await waitForPaintedFrame(video);
      if (cancelled()) return false;
    }
    slot.warm = true;
    video.pause();
    if (opts.playAfter) {
      await waitForCanPlay(video);
      if (cancelled()) return false;
      void video.play().catch(() => {});
    }
    return true;
  };

  const parkStandby = (slot: DecoderSlot, parkSec: number) => {
    if (!(slot.media instanceof HTMLVideoElement)) return;
    if (!slot.warm || !slot.src) return;
    if (
      slot.lastParkSec != null &&
      Math.abs(slot.lastParkSec - parkSec) < 0.04
    ) {
      return;
    }
    slot.lastParkSec = parkSec;
    const gen = ++slot.workGen;
    const video = slot.media;
    void (async () => {
      const didSeek = await seekMedia(video, parkSec);
      if (destroyed || slot.workGen !== gen) return;
      if (didSeek) await waitForPaintedFrame(video);
      if (destroyed || slot.workGen !== gen) return;
      video.pause();
    })();
  };

  const activateVideo = (
    slot: DecoderSlot,
    sourceSec: number,
    playing: boolean,
    clockSync: boolean,
    clipId: string | null,
    onFailed?: () => void,
  ) => {
    const video = slot.media as HTMLVideoElement;
    if (!slot.src) {
      stallReason = "no-src";
      onFailed?.();
      return;
    }

    if (clockSync) {
      let target = Math.max(0, sourceSec);
      if (Number.isFinite(video.duration) && video.duration > 0) {
        target = Math.min(target, Math.max(0, video.duration - 0.05));
      }
      if (video.ended || Math.abs(video.currentTime - target) >= 0.04) {
        try {
          if (video.ended) video.pause();
          video.currentTime = target;
        } catch {
          // ignore
        }
      }
      if (!video.paused) video.pause();
      slot.warm = true;
      markReady(slot.key);
      return;
    }

    if (!playing) {
      void alignVideo(slot, sourceSec, {
        playAfter: false,
        requirePaint: true,
      }).then((ok) => {
        if (ok) markReady(slot.key);
        else onFailed?.();
      });
      return;
    }

    // Playing free-run: one seek at cut / epoch, then native play.
    const sameClip =
      clipId != null &&
      slot.lastPlayClipId === clipId &&
      !video.paused &&
      !video.ended &&
      Math.abs(video.currentTime - sourceSec) < 0.12;

    if (sameClip) {
      markReady(slot.key);
      return;
    }

    slot.lastPlayClipId = clipId;
    const gen = ++slot.workGen;
    void (async () => {
      const ok = await alignToSourceSec(
        video,
        sourceSec,
        () => destroyed || slot.workGen !== gen,
      );
      if (!ok) {
        // Only the latest activate may clear cut bookkeeping for retry.
        if (slot.workGen === gen) {
          stallReason = "activate-failed";
          onFailed?.();
        }
        return;
      }
      slot.warm = true;
      markReady(slot.key);
      await waitForCanPlay(video);
      if (destroyed || slot.workGen !== gen) return;
      void video.play().catch(() => {});
    })();
  };

  const syncAudio = (
    clips: readonly TimelineClip[],
    currentSec: number,
    playing: boolean,
  ) => {
    const frame = resolveTimelineFrame(clips, currentSec);
    const layer = frame.audio[0] ?? null;
    const assetId = layer?.clip.assetId?.trim() || null;

    if (!layer || !assetId) {
      if (audioSlot) {
        audioSlot.workGen += 1;
        audioSlot.el.pause();
        audioSlot.el.remove();
        audioSlot = null;
        lastAudioKey = null;
      }
      return;
    }

    const reverse = Boolean(layer.clip.reverse);
    const audioKey = `a:${assetId}:${reverse ? "r" : "f"}`;
    mediaSources.ensureAsset(assetId);
    if (reverse) mediaSources.ensureReverse(assetId);

    const src = reverse
      ? mediaSources.getReverse(assetId).detail
      : mediaSources.getAsset(assetId).detail;

    if (reverse && mediaSources.getReverse(assetId).needsBake) {
      if (audioSlot) {
        audioSlot.el.pause();
      }
      return;
    }
    if (!src) return;

    if (!audioSlot || lastAudioKey !== audioKey) {
      audioSlot?.el.remove();
      const el = document.createElement("audio");
      el.className = "editor-preview-audio-el";
      el.preload = "auto";
      el.src = src;
      surface.appendChild(el);
      audioSlot = {
        assetId,
        reverse,
        el,
        workGen: 0,
        lastPlayClipId: null,
        lastSeekEpoch: -1,
      };
      lastAudioKey = audioKey;
    } else if (audioSlot.el.getAttribute("src") !== src) {
      audioSlot.el.src = src;
      audioSlot.lastPlayClipId = null;
    }

    audioSlot.el.volume = Math.max(0, Math.min(1, volume / 100));

    if (!playing) {
      audioSlot.el.pause();
      void seekMedia(audioSlot.el, layer.sourceSec);
      audioSlot.lastPlayClipId = null;
      return;
    }

    // Free-run while playing: only re-seek on clip / epoch change (parity with AudioLayer).
    const needsStart =
      audioSlot.lastPlayClipId !== layer.clip.id ||
      audioSlot.lastSeekEpoch !== mediaSeekEpoch ||
      audioSlot.el.paused;
    if (!needsStart) return;

    audioSlot.lastPlayClipId = layer.clip.id;
    audioSlot.lastSeekEpoch = mediaSeekEpoch;
    const gen = ++audioSlot.workGen;
    const el = audioSlot.el;
    const target = layer.sourceSec;
    void (async () => {
      await seekMedia(el, target);
      if (destroyed || !audioSlot || audioSlot.workGen !== gen) return;
      await waitForCanPlay(el);
      if (destroyed || !audioSlot || audioSlot.workGen !== gen) return;
      try {
        await el.play();
      } catch {
        // ignore
      }
    })();
  };

  let lastPlayClipIdForActive: string | null = null;
  let lastMediaSeekEpoch = -1;
  let lastPlaying = false;

  return {
    setStage(nextW, nextH, nextMatteW, nextMatteH) {
      stageW = nextW;
      stageH = nextH;
      matteW = nextMatteW;
      matteH = nextMatteH;
    },
    setBakeInfo(next) {
      bakeInfoByClipId = next;
    },
    setVolume(next) {
      volume = Math.max(0, Math.min(100, next));
      if (audioSlot) {
        audioSlot.el.volume = Math.max(0, Math.min(1, volume / 100));
      }
    },
    setMediaSeekEpoch(epoch) {
      mediaSeekEpoch = epoch;
    },
    sync(clips, currentSec, playing) {
      if (destroyed) return;

      const frame = resolveTimelineFrame(clips, currentSec);
      const visual = frame.visual;
      const nextActive =
        visual?.clip.kind === "slideshow" || visual?.clip.assetId?.trim()
          ? assetDecoderKey(visual.clip)
          : null;
      activeKey = nextActive;
      // Empty / gap: clear cut bookkeeping so the next clip always re-activates
      // (gap-start handoff; scrubbing a clip then seeking into a gap left a stale id).
      if (!activeKey) {
        visibleKey = null;
        lastPlayClipIdForActive = null;
      }

      const nextClip = peekNextVisualClip(clips, currentSec);
      const prepByKey = parkSourceByKey(clips);
      if (
        nextClip &&
        (nextClip.kind === "slideshow" || nextClip.assetId?.trim())
      ) {
        const key = assetDecoderKey(nextClip);
        if (!activeKey || key !== activeKey) {
          prepByKey.set(
            key,
            nextClip.kind === "slideshow" ? 0 : clipInSec(nextClip),
          );
        }
      }

      const wanted = listVisualDecoders(clips);
      const wantedKeys = new Set(wanted.map((m) => m.key));

      for (const [key, slot] of slots) {
        if (!wantedKeys.has(key)) {
          destroySlot(slot);
          slots.delete(key);
          if (visibleKey === key) visibleKey = null;
        }
      }

      for (const meta of wanted) {
        let slot = slots.get(meta.key);
        if (!slot) {
          slot = createSlot(meta);
          slots.set(meta.key, slot);
        } else {
          slot.meta = meta;
          slot.kind = slotKindFromMeta(meta);
        }
      }

      const epochChanged = mediaSeekEpoch !== lastMediaSeekEpoch;
      const playStarted = playing && !lastPlaying;
      lastMediaSeekEpoch = mediaSeekEpoch;
      lastPlaying = playing;

      let activeStatus: string | null = null;
      let activeWait = false;

      for (const slot of slots.values()) {
        const isActive = slot.key === activeKey;
        const isVisible = slot.key === visibleKey;
        const parkSec = prepByKey.get(slot.key) ?? 0;
        const framing =
          isActive && visual?.clip
            ? normalizeFraming(visual.clip.framing)
            : slot.paintedFraming;
        if (isActive) slot.paintedFraming = framing;

        applyViewportStyle(
          slot.viewport,
          slot.paintedFraming,
          stageW,
          stageH,
          matteW,
          matteH,
        );

        const resolved = resolveSrc(slot, isActive);
        if (isActive && resolved.status) {
          activeStatus = resolved.status;
          activeWait = resolved.wait;
        }

        if (!resolved.src) {
          if (slot.media instanceof HTMLVideoElement) {
            slot.media.pause();
          }
          applyMediaClass(slot.media, slot.paintedFraming, true);
          continue;
        }

        if (slot.kind === "image") {
          setImageSrc(slot, resolved.src);
          applyMediaClass(slot.media, slot.paintedFraming, !isVisible);
          if (isActive) markReady(slot.key);
          continue;
        }

        const srcChanged = setVideoSrc(slot, resolved.src);
        const clockSync = wantsClockSync(slot.kind, isActive ? visual : null);
        const sourceSec = commandedSourceSec(
          slot.kind,
          isActive,
          isActive ? visual : null,
          parkSec,
        );

        applyStretchStyle(slot.media as HTMLVideoElement, slot.paintedFraming);
        const show = isVisible && slot.warm;
        applyMediaClass(slot.media, slot.paintedFraming, !show);

        if (isActive) {
          slot.lastParkSec = null;
          const clipId = visual?.clip.id ?? null;
          // Do NOT include !warm — while playing, seek() ticks every frame and
          // would cancel the in-flight align before the first frame paints.
          const cutOrEpoch =
            srcChanged ||
            epochChanged ||
            playStarted ||
            clipId !== lastPlayClipIdForActive;

          if (clockSync || !playing || cutOrEpoch) {
            if (playing && cutOrEpoch) {
              lastCutStartedAt = performance.now();
            }
            lastPlayClipIdForActive = clipId;
            activateVideo(slot, sourceSec, playing, clockSync, clipId, () => {
              if (lastPlayClipIdForActive === clipId) {
                lastPlayClipIdForActive = null;
              }
            });
          } else if (playing && isVisible && slot.warm) {
            // Keep free-run playing once painted.
            const video = slot.media as HTMLVideoElement;
            if (video.paused) {
              void waitForCanPlay(video).then(() => {
                if (!destroyed && playing && activeKey === slot.key) {
                  void video.play().catch(() => {});
                }
              });
            }
          } else if (playing && !isVisible) {
            // Activate-from-empty still in flight or failed; surface for diagnostics.
            if (!stallReason) stallReason = "waiting-visible";
          }

          // Hold outgoing: if still visible but no longer active, pause.
        } else if (isVisible) {
          (slot.media as HTMLVideoElement).pause();
        } else if (slot.warm) {
          parkStandby(slot, parkSec);
        } else if (
          srcChanged ||
          slot.lastParkSec == null ||
          Math.abs(slot.lastParkSec - parkSec) >= 0.04
        ) {
          // Boot cold standby once per park target — avoid thrashing workGen every RAF.
          slot.lastParkSec = parkSec;
          void alignVideo(slot, parkSec, {
            playAfter: false,
            requirePaint: true,
          });
        }
      }

      if (!activeKey) {
        setStatus(
          frame.visual || frame.audio[0] ? null : "Timeline",
          false,
        );
      } else if (activeStatus) {
        stallReason = activeStatus;
        setStatus(activeStatus, activeWait);
      } else {
        setStatus(null);
      }

      syncAudio(clips, currentSec, playing);
    },
    getDiagnostics() {
      const warmKeys: string[] = [];
      for (const slot of slots.values()) {
        if (slot.warm) warmKeys.push(slot.key);
      }
      return {
        warmKeys,
        activeKey,
        visibleKey,
        lastCutLatencyMs,
        stallReason,
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const slot of slots.values()) destroySlot(slot);
      slots.clear();
      if (audioSlot) {
        audioSlot.workGen += 1;
        audioSlot.el.pause();
        audioSlot.el.remove();
        audioSlot = null;
      }
      statusEl?.remove();
      statusEl = null;
      visibleKey = null;
      activeKey = null;
      stallReason = null;
      lastCutLatencyMs = null;
    },
  };
}

/** Source sec helper exported for unit tests. */
export function decoderCommandedSourceSec(
  kind: "video" | "image" | "slideshow" | "extend",
  active: boolean,
  liveLayer: TimelineLayer | null,
  parkSec: number,
): number {
  return commandedSourceSec(kind, active, liveLayer, parkSec);
}

export function decoderWantsClockSync(
  kind: "video" | "image" | "slideshow" | "extend",
  liveLayer: TimelineLayer | null,
): boolean {
  return wantsClockSync(kind, liveLayer);
}
