import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { ensureLocal, getCreation } from "../../library/catalogClient";
import {
  canFetchLocal,
  creationDetailUrl,
  creationPreviewUrl,
  isParasceneUnavailable,
} from "../../library/previewUrl";
import type { Creation } from "../../library/types";
import type { TimelineClip } from "../../project/types";
import {
  resolveTimelineFrame,
  type TimelineLayer,
} from "./timelineCompose";

type TimelineMonitorProps = {
  clips: TimelineClip[];
  playheadSec: number;
  playing: boolean;
  /** Bumped on scrub-while-playing / loop wrap. */
  mediaSeekEpoch?: number;
  volume: number;
};

type MediaUrls = {
  detail: string | null;
  thumb: string | null;
  waitingLocal: boolean;
};

/** Load catalog media for one asset; remount via key when assetId changes. */
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

/**
 * Program monitor media for timeline mode: image (and later video) under the
 * playhead, plus audio-lane playback synced to timeline time.
 */
export function TimelineMonitor({
  clips,
  playheadSec,
  playing,
  mediaSeekEpoch = 0,
  volume,
}: TimelineMonitorProps) {
  const frame = resolveTimelineFrame(clips, playheadSec);
  const visual = frame.visual;
  const audioLayer = frame.audio[0] ?? null;

  const visualAssetId = visual?.clip.assetId?.trim() || null;
  const audioAssetId = audioLayer?.clip.assetId?.trim() || null;

  return (
    <>
      {visual && visualAssetId ? (
        <VisualLayer
          key={visualAssetId}
          assetId={visualAssetId}
          layer={visual}
          playing={playing}
          mediaSeekEpoch={mediaSeekEpoch}
          fallbackThumb={
            typeof visual.clip.thumbUrl === "string"
              ? visual.clip.thumbUrl
              : null
          }
        />
      ) : null}

      {audioLayer && audioAssetId ? (
        <AudioLayer
          key={audioAssetId}
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

function VisualLayer({
  assetId,
  layer,
  playing,
  mediaSeekEpoch,
  fallbackThumb,
}: {
  assetId: string;
  layer: TimelineLayer;
  playing: boolean;
  mediaSeekEpoch: number;
  fallbackThumb: string | null;
}) {
  const media = useAssetMedia(assetId);
  const src = media.detail ?? media.thumb ?? fallbackThumb;
  const kind = layer.clip.kind ?? "image";

  if (!src) {
    return media.waitingLocal ? (
      <span className="editor-preview-wait muted">Saving locally…</span>
    ) : null;
  }

  if (kind === "video" && media.detail) {
    return (
      <TimelineVideoLayer
        src={media.detail}
        poster={media.thumb ?? fallbackThumb}
        layer={layer}
        playing={playing}
        mediaSeekEpoch={mediaSeekEpoch}
      />
    );
  }

  return (
    <img
      className="editor-preview-media editor-preview-detail"
      src={src}
      alt=""
      draggable={false}
    />
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
  if (!media.detail) return null;
  return (
    <TimelineAudioLayer
      src={media.detail}
      layer={layer}
      playing={playing}
      mediaSeekEpoch={mediaSeekEpoch}
      volume={volume}
    />
  );
}

/** Seek a media element and resolve on `seeked` (or timeout). */
function seekMedia(el: HTMLMediaElement, sec: number): Promise<void> {
  const target = Math.max(0, sec);
  if (Number.isFinite(el.currentTime) && Math.abs(el.currentTime - target) < 0.04) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("seeked", finish);
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 800);
    el.addEventListener("seeked", finish);
    try {
      el.currentTime = target;
    } catch {
      finish();
    }
  });
}

/** After a seek, wait until the engine can decode ahead (reduces start glitches). */
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

function TimelineVideoLayer({
  src,
  poster,
  layer,
  playing,
  mediaSeekEpoch,
}: {
  src: string;
  poster: string | null;
  layer: TimelineLayer;
  playing: boolean;
  mediaSeekEpoch: number;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const sourceSecRef = useRef(layer.sourceSec);
  const playingRef = useRef(playing);

  useEffect(() => {
    sourceSecRef.current = layer.sourceSec;
  }, [layer.sourceSec]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    if (playing) return;
    const el = ref.current;
    if (!el) return;
    void seekMedia(el, layer.sourceSec);
  }, [layer.clip.id, layer.sourceSec, playing]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (!playing) {
      el.pause();
      return;
    }

    let cancelled = false;

    const start = async () => {
      await seekMedia(el, sourceSecRef.current);
      if (cancelled || !playingRef.current) return;
      const live = sourceSecRef.current;
      if (Math.abs(el.currentTime - live) > 0.15) {
        await seekMedia(el, live);
      }
      if (cancelled || !playingRef.current) return;
      await waitForCanPlay(el);
      if (cancelled || !playingRef.current) return;
      void el.play().catch(() => {
        // autoplay / decode errors — keep silent
      });
    };

    void start();
    return () => {
      cancelled = true;
    };
  }, [playing, layer.clip.id, src, mediaSeekEpoch]);

  return (
    <video
      ref={ref}
      className="editor-preview-media editor-preview-detail"
      src={src}
      poster={poster ?? undefined}
      playsInline
      preload="auto"
      muted
    />
  );
}

function TimelineAudioLayer({
  src,
  layer,
  playing,
  mediaSeekEpoch,
  volume,
}: {
  src: string;
  layer: TimelineLayer;
  playing: boolean;
  mediaSeekEpoch: number;
  volume: number;
}) {
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

  // Scrub while paused — snap only.
  useEffect(() => {
    if (playing) return;
    const el = ref.current;
    if (!el) return;
    void seekMedia(el, layer.sourceSec);
  }, [layer.sourceSec, layer.clip.id, playing]);

  // Prime on play and whenever the playhead jumps while playing (scrub / loop).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (!playing) {
      el.pause();
      return;
    }

    let cancelled = false;

    const start = async () => {
      await seekMedia(el, sourceSecRef.current);
      if (cancelled || !playingRef.current) return;
      const live = sourceSecRef.current;
      if (Math.abs(el.currentTime - live) > 0.15) {
        await seekMedia(el, live);
      }
      if (cancelled || !playingRef.current) return;
      await waitForCanPlay(el);
      if (cancelled || !playingRef.current) return;
      try {
        await el.play();
      } catch {
        // autoplay / decode errors — keep silent
      }
    };

    void start();
    return () => {
      cancelled = true;
    };
  }, [playing, layer.clip.id, src, mediaSeekEpoch]);

  return (
    <audio
      ref={ref}
      className="editor-preview-audio-el"
      src={src}
      preload="auto"
    />
  );
}
