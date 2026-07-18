import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensureLocal, getCreation } from "../../library/catalogClient";
import {
  canFetchLocal,
  creationDetailUrl,
  creationPreviewUrl,
  isParasceneUnavailable,
} from "../../library/previewUrl";
import {
  ensureReversedMedia,
  getCachedReversedMedia,
} from "../../library/reversedMedia";
import { mediaUrlForBakePath } from "../../library/slideshowMedia";
import type { Creation } from "../../library/types";
import type { TimelineClip } from "../../project/types";
import {
  framingClassName,
  framingViewportStyle,
  normalizeFraming,
  type StagedClipFraming,
} from "./stagedClip";
import {
  clipInSec,
  peekNextVisualClip,
  resolveTimelineFrame,
  type TimelineLayer,
} from "./timelineCompose";
import { useVideoStretchStyle } from "./useVideoStretchStyle";

type TimelineMonitorProps = {
  clips: TimelineClip[];
  playheadSec: number;
  playing: boolean;
  mediaSeekEpoch?: number;
  volume: number;
  /** 16:9 preview stage size in CSS px. */
  stageW: number;
  stageH: number;
  /** Project aspect matte size in CSS px (centered in the stage). */
  matteW: number;
  matteH: number;
};

type MediaUrls = {
  detail: string | null;
  thumb: string | null;
  waitingLocal: boolean;
};

/** Unique decoder identity: one DOM media element per asset × direction. */
export type AssetDecoderKey = string;

export function assetDecoderKey(clip: TimelineClip): AssetDecoderKey {
  if (clip.kind === "slideshow") {
    const bake = clip.bakeKey?.trim() || clip.bakePath?.trim() || "pending";
    return `slideshow:${clip.id}:${bake}`;
  }
  const assetId = clip.assetId?.trim() || clip.id;
  return `${assetId}:${clip.reverse ? "r" : "f"}`;
}

function isSlideshowKey(key: AssetDecoderKey): boolean {
  return key.startsWith("slideshow:");
}

function assetIdFromKey(key: AssetDecoderKey): string {
  if (isSlideshowKey(key)) return "";
  const idx = key.lastIndexOf(":");
  return idx >= 0 ? key.slice(0, idx) : key;
}

function isReverseKey(key: AssetDecoderKey): boolean {
  if (isSlideshowKey(key)) return false;
  return key.endsWith(":r");
}

type VisualDecoderMeta = {
  key: AssetDecoderKey;
  kind: "video" | "image" | "slideshow";
  bakePath?: string | null;
};

/** Every unique video/image backing asset on the video lane. */
function listVisualDecoders(
  clips: readonly TimelineClip[],
): VisualDecoderMeta[] {
  const byKey = new Map<AssetDecoderKey, VisualDecoderMeta>();
  for (const clip of clips) {
    if (clip.lane === "audio") continue;
    if (clip.kind === "audio") continue;
    if (clip.kind === "slideshow") {
      const key = assetDecoderKey(clip);
      byKey.set(key, {
        key,
        kind: "slideshow",
        bakePath: clip.bakePath ?? null,
      });
      continue;
    }
    if (!clip.assetId?.trim()) continue;
    const kind = clip.kind === "image" ? "image" : "video";
    const key = assetDecoderKey(clip);
    // Prefer video if the same key ever appears as both (shouldn't).
    const prev = byKey.get(key);
    if (!prev || (prev.kind === "image" && kind === "video")) {
      byKey.set(key, { key, kind });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Park each standby decoder on the earliest in-point for that asset×direction.
 * Keeps cold slots off frame 0 so the first scrub cut doesn't flash.
 */
function parkSourceByKey(
  clips: readonly TimelineClip[],
): Map<AssetDecoderKey, number> {
  const map = new Map<AssetDecoderKey, number>();
  const videoClips = clips
    .filter((c) => c.lane !== "audio")
    .filter((c) => c.kind !== "audio")
    .filter(
      (c) =>
        c.kind === "slideshow" || Boolean(c.assetId?.trim()),
    )
    .slice()
    .sort(
      (a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id),
    );
  for (const clip of videoClips) {
    const key = assetDecoderKey(clip);
    if (!map.has(key)) {
      map.set(key, clip.kind === "slideshow" ? 0 : clipInSec(clip));
    }
  }
  return map;
}

function useAssetMedia(assetId: string): MediaUrls {
  const [creation, setCreation] = useState<Creation | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void getCreation(assetId)
      .then((row) => {
        if (cancelled) return;
        setCreation(row);
        if (
          !creationDetailUrl(row) &&
          canFetchLocal(row) &&
          !isParasceneUnavailable(row)
        ) {
          void ensureLocal([row.id], { fullMedia: true, urgent: true });
        }
      })
      .catch(() => {
        if (!cancelled) setCreation(null);
      });

    void listen<Creation>("library-creation-updated", (event) => {
      if (event.payload.id !== assetId) return;
      setCreation(event.payload);
      setDetailFailed(false);
    }).then((off) => {
      unlisten = off;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [assetId]);

  const detail =
    creation && !detailFailed ? creationDetailUrl(creation) : null;
  const thumb = creation ? creationPreviewUrl(creation) : null;
  const unavailable = creation ? isParasceneUnavailable(creation) : false;
  const waitingLocal =
    Boolean(creation) &&
    !detail &&
    !thumb &&
    canFetchLocal(creation!) &&
    !unavailable;

  return { detail, thumb, waitingLocal };
}

function useReversedDetail(
  assetId: string,
  enabled: boolean,
  sourceReady: boolean,
): { detail: string | null; busy: boolean; error: string | null } {
  const cached = enabled && sourceReady ? getCachedReversedMedia(assetId) : null;
  const [detail, setDetail] = useState<string | null>(
    () => cached?.mediaUrl ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!enabled || !sourceReady) {
    if (detail !== null) setDetail(null);
    if (busy) setBusy(false);
    if (error !== null) setError(null);
  } else if (cached && detail !== cached.mediaUrl) {
    setDetail(cached.mediaUrl);
    if (busy) setBusy(false);
    if (error !== null) setError(null);
  }

  useEffect(() => {
    if (!enabled || !sourceReady) return;
    if (getCachedReversedMedia(assetId)) return;

    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setBusy(true);
      setError(null);
      setDetail(null);
    });

    void ensureReversedMedia(assetId)
      .then((urls) => {
        if (cancelled) return;
        setDetail(urls.mediaUrl);
        setBusy(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "Could not reverse media";
        setError(message);
        setBusy(false);
        setDetail(null);
      });

    return () => {
      cancelled = true;
    };
  }, [assetId, enabled, sourceReady]);

  return { detail, busy, error };
}

/** Resolves true when a seek was issued, false when already at the target. */
function seekMedia(el: HTMLMediaElement, sec: number): Promise<boolean> {
  let target = Math.max(0, sec);
  // Stay off the exact EOF so we don't land in `ended` (WebKit then refuses
  // to advance until a fresh seek after loop/wrap).
  if (Number.isFinite(el.duration) && el.duration > 0) {
    target = Math.min(target, Math.max(0, el.duration - 0.05));
  }
  if (
    !el.ended &&
    Number.isFinite(el.currentTime) &&
    Math.abs(el.currentTime - target) < 0.04
  ) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("seeked", finish);
      window.clearTimeout(fallback);
      resolve(true);
    };
    const fallback = window.setTimeout(finish, 800);
    el.addEventListener("seeked", finish);
    try {
      // Clear ended before assigning; some WebKit builds no-op seeks while ended.
      if (el.ended) el.pause();
      el.currentTime = target;
    } catch {
      finish();
    }
  });
}

function waitForCurrentFrame(el: HTMLMediaElement): Promise<void> {
  if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("loadeddata", finish);
      el.removeEventListener("canplay", finish);
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 800);
    el.addEventListener("loadeddata", finish);
    el.addEventListener("canplay", finish);
  });
}

/** Prefer rVFC so we know a frame at the seek target was actually produced. */
function waitForPaintedFrame(el: HTMLVideoElement): Promise<void> {
  const withRvfc = el as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number;
  };
  if (typeof withRvfc.requestVideoFrameCallback === "function") {
    return new Promise((resolve) => {
      const fallback = window.setTimeout(resolve, 400);
      withRvfc.requestVideoFrameCallback!(() => {
        window.clearTimeout(fallback);
        resolve();
      });
    });
  }
  return waitForCurrentFrame(el);
}

function waitForCanPlay(el: HTMLMediaElement): Promise<void> {
  if (el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("canplay", finish);
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 800);
    el.addEventListener("canplay", finish);
  });
}

/**
 * Program monitor: one persistent <video>/<img> per backing asset×direction
 * present on the timeline. Playback is visibility + seek + play/pause among
 * those elements — never a hold-frame swap on cuts while playing.
 *
 * Presentation is gated separately from "active" (playhead target): the
 * previous decoder stays visible until the incoming one has seeked to the
 * exact source time. That is what kills the scrub first-frame flash —
 * parking at in-point is not enough when the playhead lands mid-clip.
 */
export function TimelineMonitor({
  clips,
  playheadSec,
  playing,
  mediaSeekEpoch = 0,
  volume,
  stageW,
  stageH,
  matteW,
  matteH,
}: TimelineMonitorProps) {
  const frame = resolveTimelineFrame(clips, playheadSec);
  const visual = frame.visual;
  const audioLayer = frame.audio[0] ?? null;
  const audioAssetId = audioLayer?.clip.assetId?.trim() || null;

  const decoders = useMemo(() => listVisualDecoders(clips), [clips]);

  const activeKey =
    visual?.clip.kind === "slideshow" || visual?.clip.assetId?.trim()
      ? assetDecoderKey(visual.clip)
      : null;

  const [visibleKey, setVisibleKey] = useState<AssetDecoderKey | null>(null);

  if (!activeKey && visibleKey) {
    setVisibleKey(null);
  }

  // Decoders only report ready from active effects, whose cleanup cancels
  // pending async video work. Accepting that signal directly avoids the
  // parent/child effect-order race on immediate image handoffs.
  const onDecoderReady = useCallback((key: AssetDecoderKey) => {
    setVisibleKey(key);
  }, []);

  const nextClip = useMemo(() => {
    return peekNextVisualClip(clips, playheadSec);
  }, [clips, playheadSec]);

  /**
   * Standby park times: earliest in-point per decoder, with look-ahead
   * override for the upcoming cut (play or scrub).
   */
  const prepByKey = (() => {
    const map = parkSourceByKey(clips);
    if (
      nextClip &&
      (nextClip.kind === "slideshow" || nextClip.assetId?.trim())
    ) {
      const key = assetDecoderKey(nextClip);
      if (!activeKey || key !== activeKey) {
        map.set(key, nextClip.kind === "slideshow" ? 0 : clipInSec(nextClip));
      }
    }
    return map;
  })();

  return (
    <>
      {decoders.map(({ key, kind, bakePath }) => {
        const isActive = key === activeKey;
        const isVisible = key === visibleKey;
        const parkSec = prepByKey.get(key) ?? 0;
        const framing =
          isActive && visual?.clip
            ? normalizeFraming(visual.clip.framing)
            : "fit";
        if (kind === "slideshow") {
          return (
            <SlideshowDecoder
              key={key}
              decoderKey={key}
              bakePath={bakePath ?? null}
              active={isActive}
              visible={isVisible}
              framing={framing}
              stageW={stageW}
              stageH={stageH}
              matteW={matteW}
              matteH={matteH}
              liveLayer={isActive ? visual : null}
              prepSourceSec={isActive ? null : parkSec}
              playing={isActive && playing}
              mediaSeekEpoch={mediaSeekEpoch}
              onReady={onDecoderReady}
            />
          );
        }
        return (
          <AssetDecoder
            key={key}
            decoderKey={key}
            kind={kind}
            active={isActive}
            visible={isVisible}
            framing={framing}
            stageW={stageW}
            stageH={stageH}
            matteW={matteW}
            matteH={matteH}
            liveLayer={isActive ? visual : null}
            prepSourceSec={isActive ? null : parkSec}
            playing={isActive && playing}
            mediaSeekEpoch={mediaSeekEpoch}
            onReady={onDecoderReady}
          />
        );
      })}

      {audioLayer && audioAssetId ? (
        <AudioLayer
          key={`a:${audioAssetId}:${audioLayer.clip.reverse ? "r" : "f"}`}
          assetId={audioAssetId}
          layer={audioLayer}
          playing={playing}
          mediaSeekEpoch={mediaSeekEpoch}
          volume={volume}
        />
      ) : null}

      {!visual && !audioLayer ? (
        <span className="editor-preview-status muted">Timeline</span>
      ) : null}
    </>
  );
}

function SlideshowDecoder({
  decoderKey,
  bakePath,
  active,
  visible,
  framing,
  stageW,
  stageH,
  matteW,
  matteH,
  liveLayer,
  prepSourceSec,
  playing,
  mediaSeekEpoch,
  onReady,
}: {
  decoderKey: AssetDecoderKey;
  bakePath: string | null;
  active: boolean;
  visible: boolean;
  framing: StagedClipFraming;
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
  liveLayer: TimelineLayer | null;
  prepSourceSec: number | null;
  playing: boolean;
  mediaSeekEpoch: number;
  onReady: (key: AssetDecoderKey) => void;
}) {
  const [paintedFraming, setPaintedFraming] =
    useState<StagedClipFraming>(framing);
  if (active && paintedFraming !== framing) {
    setPaintedFraming(framing);
  }
  const effectiveFraming = active ? framing : paintedFraming;

  if (active && !bakePath) {
    return (
      <span className="editor-preview-wait muted">Hit Render to generate</span>
    );
  }
  if (!bakePath) return null;

  let videoSrc: string | null = null;
  try {
    videoSrc = mediaUrlForBakePath(bakePath);
  } catch {
    videoSrc = null;
  }
  if (!videoSrc) {
    if (active) {
      return (
        <span className="editor-preview-status muted">
          Slideshow bake unavailable
        </span>
      );
    }
    return null;
  }

  // Slideshow bakes are silent MP4s starting at t=0 for the clip span.
  // Staging uses inSec=0 / outSec=duration, so sourceSec == localSec.
  // Clock-sync (not free-run): silent stills must follow the playhead so a
  // timeline loop can leave EOF and advance through images again.
  return (
    <PersistentVideo
      decoderKey={decoderKey}
      src={videoSrc}
      active={active}
      visible={visible}
      framing={effectiveFraming}
      stageW={stageW}
      stageH={stageH}
      matteW={matteW}
      matteH={matteH}
      sourceSec={active ? (liveLayer?.sourceSec ?? 0) : (prepSourceSec ?? 0)}
      playing={playing}
      mediaSeekEpoch={mediaSeekEpoch}
      clipId={liveLayer?.clip.id ?? null}
      clockSync
      onReady={onReady}
    />
  );
}

function AssetDecoder({
  decoderKey,
  kind,
  active,
  visible,
  framing,
  stageW,
  stageH,
  matteW,
  matteH,
  liveLayer,
  prepSourceSec,
  playing,
  mediaSeekEpoch,
  onReady,
}: {
  decoderKey: AssetDecoderKey;
  kind: "video" | "image";
  /** Playhead currently maps to this decoder. */
  active: boolean;
  /** Actually painted in the preview (after seek alignment). */
  visible: boolean;
  framing: StagedClipFraming;
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
  liveLayer: TimelineLayer | null;
  /** Parked source time while standby (always set for non-active videos). */
  prepSourceSec: number | null;
  playing: boolean;
  mediaSeekEpoch: number;
  onReady: (key: AssetDecoderKey) => void;
}) {
  // Hold the last framing used while this decoder was active. When a cut
  // begins, the outgoing decoder can remain visible briefly while the incoming
  // frame primes, and must not snap back to Fit during that hold.
  const [paintedFraming, setPaintedFraming] =
    useState<StagedClipFraming>(framing);
  if (active && paintedFraming !== framing) {
    setPaintedFraming(framing);
  }
  const effectiveFraming = active ? framing : paintedFraming;

  const assetId = assetIdFromKey(decoderKey);
  const reverse = isReverseKey(decoderKey);
  const media = useAssetMedia(assetId);
  const wantsReverse = reverse && kind === "video";
  const reversed = useReversedDetail(
    assetId,
    wantsReverse,
    Boolean(media.detail),
  );

  const videoSrc = wantsReverse ? reversed.detail : media.detail;
  const imageSrc =
    kind === "image" ? media.detail ?? media.thumb : null;

  if (active && wantsReverse && reversed.busy) {
    return <span className="editor-preview-wait muted">Reversing…</span>;
  }
  if (active && wantsReverse && reversed.error) {
    return (
      <span className="editor-preview-status muted">{reversed.error}</span>
    );
  }

  if (kind === "video" && videoSrc) {
    return (
      <PersistentVideo
        decoderKey={decoderKey}
        src={videoSrc}
        active={active}
        visible={visible}
        framing={effectiveFraming}
        stageW={stageW}
        stageH={stageH}
        matteW={matteW}
        matteH={matteH}
        sourceSec={active ? (liveLayer?.sourceSec ?? 0) : (prepSourceSec ?? 0)}
        playing={playing}
        mediaSeekEpoch={mediaSeekEpoch}
        clipId={liveLayer?.clip.id ?? null}
        onReady={onReady}
      />
    );
  }

  if (imageSrc) {
    return (
      <PersistentImage
        decoderKey={decoderKey}
        src={imageSrc}
        active={active}
        visible={visible}
        framing={effectiveFraming}
        stageW={stageW}
        stageH={stageH}
        matteW={matteW}
        matteH={matteH}
        onReady={onReady}
      />
    );
  }

  if (active && media.waitingLocal) {
    return <span className="editor-preview-wait muted">Saving locally…</span>;
  }
  return null;
}

function PersistentImage({
  decoderKey,
  src,
  active,
  visible,
  framing,
  stageW,
  stageH,
  matteW,
  matteH,
  onReady,
}: {
  decoderKey: AssetDecoderKey;
  src: string;
  active: boolean;
  visible: boolean;
  framing: StagedClipFraming;
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
  onReady: (key: AssetDecoderKey) => void;
}) {
  useEffect(() => {
    if (active) onReady(decoderKey);
  }, [active, decoderKey, onReady, src]);

  const viewport = framingViewportStyle(
    framing,
    stageW,
    stageH,
    matteW,
    matteH,
  );

  return (
    <div
      className={`editor-preview-framing-viewport${
        viewport ? " is-project-matte" : ""
      }`}
      style={viewport}
    >
      <img
        className={`editor-preview-media editor-preview-detail ${framingClassName(framing)}${
          visible ? "" : " is-standby"
        }`}
        src={src}
        alt=""
        draggable={false}
      />
    </div>
  );
}

/**
 * One long-lived video for an asset×direction. Visibility / seek / play only —
 * no remount across timeline clips that share this decoder.
 *
 * `active` = playhead wants this decoder. `visible` = parent has committed it
 * for paint (after we reported ready at the commanded source time). While
 * active-but-not-visible we seek under cover; the previous decoder stays up.
 */
function PersistentVideo({
  decoderKey,
  src,
  active,
  visible,
  framing,
  stageW,
  stageH,
  matteW,
  matteH,
  sourceSec,
  playing,
  mediaSeekEpoch,
  clipId,
  clockSync = false,
  onReady,
}: {
  decoderKey: AssetDecoderKey;
  src: string;
  active: boolean;
  visible: boolean;
  framing: StagedClipFraming;
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
  sourceSec: number;
  playing: boolean;
  mediaSeekEpoch: number;
  clipId: string | null;
  /**
   * When true, keep media time glued to `sourceSec` (slideshow bakes).
   * Free-run is wrong for silent still montages: hitting EOF hangs on the
   * last image across a timeline loop.
   */
  clockSync?: boolean;
  onReady: (key: AssetDecoderKey) => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const sourceSecRef = useRef(sourceSec);
  const playingRef = useRef(playing);
  const activeRef = useRef(active);
  const onReadyRef = useRef(onReady);
  /** Has decoded at least one frame at some parked/commanded time. */
  const [warm, setWarm] = useState(false);
  const stretchStyle = useVideoStretchStyle(framing, ref, src);
  const viewport = framingViewportStyle(
    framing,
    stageW,
    stageH,
    matteW,
    matteH,
  );

  useEffect(() => {
    sourceSecRef.current = sourceSec;
  }, [sourceSec]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  /** Seek to the latest commanded time, then paint-wait; re-seek if command moved. */
  const alignToCommand = async (el: HTMLVideoElement, cancelled: () => boolean) => {
    for (;;) {
      const target = sourceSecRef.current;
      const didSeek = await seekMedia(el, target);
      if (cancelled()) return false;
      // A parked decoder already has the correct frame painted. Waiting for
      // rVFC in that case stalls until its timeout because paused media emits
      // no new frame callback.
      if (didSeek) {
        await waitForPaintedFrame(el);
        if (cancelled()) return false;
      }
      if (Math.abs(sourceSecRef.current - target) < 0.05) return true;
    }
  };

  // Initial attach / src change — decode ready, then seek to commanded time.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    setWarm(false);

    const boot = async () => {
      const ok = await alignToCommand(el, () => cancelled);
      if (cancelled || !ok) return;
      setWarm(true);
      el.pause();
      if (activeRef.current) {
        onReadyRef.current(decoderKey);
        if (playingRef.current && !clockSync) {
          await waitForCanPlay(el);
          if (cancelled || !playingRef.current || !activeRef.current) return;
          void el.play().catch(() => {});
        }
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
    // decoderKey/src identity only — align uses refs for the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, decoderKey, clockSync]);

  // Standby park: only once we've left the screen — never disturb a hold frame.
  useEffect(() => {
    if (active || visible || !warm) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const didSeek = await seekMedia(el, sourceSec);
      if (cancelled) return;
      // Finish decoding the parked target now, while hidden, so activation at
      // this same source time can hand off immediately.
      if (didSeek) await waitForPaintedFrame(el);
      if (cancelled) return;
      el.pause();
    })();
    return () => {
      cancelled = true;
    };
  }, [active, visible, warm, sourceSec]);

  // Slideshow / clock-sync: playhead is the clock. Keep the paused element on
  // the commanded frame so timeline loops leave EOF and stills keep advancing.
  useEffect(() => {
    if (!clockSync || !active || !warm) return;
    const el = ref.current;
    if (!el) return;
    let target = Math.max(0, sourceSec);
    if (Number.isFinite(el.duration) && el.duration > 0) {
      target = Math.min(target, Math.max(0, el.duration - 0.05));
    }
    if (el.ended || Math.abs(el.currentTime - target) >= 0.04) {
      try {
        if (el.ended) el.pause();
        el.currentTime = target;
      } catch {
        // ignore seek errors on detached / not-ready elements
      }
    }
    if (!el.paused) el.pause();
    onReadyRef.current(decoderKey);
  }, [
    clockSync,
    active,
    warm,
    sourceSec,
    clipId,
    mediaSeekEpoch,
    decoderKey,
  ]);

  // Scrub / pause: follow commanded sourceSec. Do NOT run this while playing —
  // playhead ticks every frame and would interrupt free-running media.
  useEffect(() => {
    if (clockSync || !active || !warm || playing) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const ok = await alignToCommand(el, () => cancelled);
      if (cancelled || !ok) return;
      el.pause();
      onReadyRef.current(decoderKey);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clockSync, active, warm, playing, sourceSec, clipId, mediaSeekEpoch, decoderKey]);

  // Cut / activate while playing: one align at the commanded in-point, then
  // free-run. Intentionally omits sourceSec so playhead ticks don't re-seek.
  useEffect(() => {
    if (clockSync || !active || !warm || !playing) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const ok = await alignToCommand(el, () => cancelled);
      if (cancelled || !ok) return;
      onReadyRef.current(decoderKey);
      await waitForCanPlay(el);
      if (cancelled || !playingRef.current || !activeRef.current) return;
      void el.play().catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clockSync, active, warm, playing, clipId, mediaSeekEpoch, decoderKey]);

  // Keep play/pause in sync once this decoder is the painted one.
  useEffect(() => {
    if (clockSync) return;
    const el = ref.current;
    if (!el || !active || !visible || !warm) return;
    if (!playing) {
      el.pause();
      return;
    }
    if (!el.paused) return;
    let cancelled = false;
    void (async () => {
      await waitForCanPlay(el);
      if (cancelled || !playingRef.current) return;
      void el.play().catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [clockSync, playing, active, visible, warm]);

  // Inactive but still visible = hold last frame until the incoming decoder is ready.
  useEffect(() => {
    if (active || !visible) return;
    const el = ref.current;
    if (!el) return;
    el.pause();
  }, [active, visible]);

  return (
    <div
      className={`editor-preview-framing-viewport${
        viewport ? " is-project-matte" : ""
      }`}
      style={viewport}
    >
      <video
        ref={ref}
        className={`editor-preview-media editor-preview-detail ${framingClassName(framing)}${
          visible && warm ? "" : " is-standby"
        }`}
        style={stretchStyle}
        src={src}
        playsInline
        preload="auto"
        muted
      />
    </div>
  );
}

function AudioLayer({
  assetId,
  layer,
  playing,
  mediaSeekEpoch,
  volume,
}: {
  assetId: string;
  layer: TimelineLayer;
  playing: boolean;
  mediaSeekEpoch: number;
  volume: number;
}) {
  const media = useAssetMedia(assetId);
  const wantsReverse = Boolean(layer.clip.reverse);
  const reversed = useReversedDetail(
    assetId,
    wantsReverse,
    Boolean(media.detail),
  );
  const src = wantsReverse ? reversed.detail : media.detail;
  const ref = useRef<HTMLAudioElement | null>(null);
  const sourceSecRef = useRef(layer.sourceSec);
  const playingRef = useRef(playing);

  useEffect(() => {
    sourceSecRef.current = layer.sourceSec;
  }, [layer.sourceSec]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, volume / 100));
  }, [volume]);

  useEffect(() => {
    if (!src) return;
    const el = ref.current;
    if (!el) return;
    if (playing) return;
    void seekMedia(el, layer.sourceSec);
  }, [src, layer.sourceSec, layer.clip.id, playing]);

  useEffect(() => {
    if (!src) return;
    const el = ref.current;
    if (!el) return;
    if (!playing) {
      el.pause();
      return;
    }
    let cancelled = false;
    void (async () => {
      await seekMedia(el, sourceSecRef.current);
      if (cancelled || !playingRef.current) return;
      await waitForCanPlay(el);
      if (cancelled || !playingRef.current) return;
      try {
        await el.play();
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, playing, layer.clip.id, mediaSeekEpoch]);

  if (wantsReverse && reversed.busy) return null;
  if (!src) return null;

  return (
    <audio
      ref={ref}
      className="editor-preview-audio-el"
      src={src}
      preload="auto"
    />
  );
}
