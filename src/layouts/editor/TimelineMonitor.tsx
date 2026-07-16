import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
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
import type { Creation } from "../../library/types";
import type { TimelineClip } from "../../project/types";
import {
  clipInSec,
  peekNextVisualClip,
  resolveTimelineFrame,
  type TimelineLayer,
} from "./timelineCompose";

type TimelineMonitorProps = {
  clips: TimelineClip[];
  playheadSec: number;
  playing: boolean;
  mediaSeekEpoch?: number;
  volume: number;
};

type MediaUrls = {
  detail: string | null;
  thumb: string | null;
  waitingLocal: boolean;
};

/** Unique decoder identity: one DOM media element per asset × direction. */
export type AssetDecoderKey = string;

export function assetDecoderKey(clip: TimelineClip): AssetDecoderKey {
  const assetId = clip.assetId?.trim() || clip.id;
  return `${assetId}:${clip.reverse ? "r" : "f"}`;
}

function assetIdFromKey(key: AssetDecoderKey): string {
  const idx = key.lastIndexOf(":");
  return idx >= 0 ? key.slice(0, idx) : key;
}

function isReverseKey(key: AssetDecoderKey): boolean {
  return key.endsWith(":r");
}

type VisualDecoderMeta = {
  key: AssetDecoderKey;
  kind: "video" | "image";
};

/** Every unique video/image backing asset on the video lane. */
function listVisualDecoders(
  clips: readonly TimelineClip[],
): VisualDecoderMeta[] {
  const byKey = new Map<AssetDecoderKey, VisualDecoderMeta>();
  for (const clip of clips) {
    if (clip.lane === "audio") continue;
    if (!clip.assetId?.trim()) continue;
    const kind = clip.kind === "image" ? "image" : "video";
    if (clip.kind === "audio") continue;
    const key = assetDecoderKey(clip);
    // Prefer video if the same key ever appears as both (shouldn't).
    const prev = byKey.get(key);
    if (!prev || (prev.kind === "image" && kind === "video")) {
      byKey.set(key, { key, kind });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
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
  const cached = enabled ? getCachedReversedMedia(assetId) : null;
  const [detail, setDetail] = useState<string | null>(
    () => cached?.mediaUrl ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !sourceReady) {
      setDetail(null);
      setBusy(false);
      setError(null);
      return;
    }

    const hit = getCachedReversedMedia(assetId);
    if (hit) {
      setDetail(hit.mediaUrl);
      setBusy(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setBusy(true);
    setError(null);
    setDetail(null);

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

function seekMedia(el: HTMLMediaElement, sec: number): Promise<void> {
  const target = Math.max(0, sec);
  if (
    Number.isFinite(el.currentTime) &&
    Math.abs(el.currentTime - target) < 0.04
  ) {
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
  const audioAssetId = audioLayer?.clip.assetId?.trim() || null;

  const decoders = useMemo(() => listVisualDecoders(clips), [clips]);

  const liveKey = visual?.clip.assetId?.trim()
    ? assetDecoderKey(visual.clip)
    : null;

  const nextClip = useMemo(() => {
    if (!playing) return null;
    return peekNextVisualClip(clips, playheadSec);
  }, [playing, clips, playheadSec]);

  /** Where each non-live decoder should sit while we play. */
  const prepByKey = useMemo(() => {
    const map = new Map<AssetDecoderKey, number>();
    if (!playing || !nextClip?.assetId?.trim()) return map;
    const key = assetDecoderKey(nextClip);
    // Same-asset next: one decoder can't play and pre-seek; skip prep.
    if (liveKey && key === liveKey) return map;
    map.set(key, clipInSec(nextClip));
    return map;
  }, [playing, nextClip, liveKey]);

  return (
    <>
      {decoders.map(({ key, kind }) => {
        const isLive = key === liveKey;
        return (
          <AssetDecoder
            key={key}
            decoderKey={key}
            kind={kind}
            live={isLive}
            liveLayer={isLive ? visual : null}
            prepSourceSec={isLive ? null : (prepByKey.get(key) ?? null)}
            playing={isLive && playing}
            mediaSeekEpoch={mediaSeekEpoch}
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

function AssetDecoder({
  decoderKey,
  kind,
  live,
  liveLayer,
  prepSourceSec,
  playing,
  mediaSeekEpoch,
}: {
  decoderKey: AssetDecoderKey;
  kind: "video" | "image";
  live: boolean;
  liveLayer: TimelineLayer | null;
  /** When non-live and playing soon: park at this source time. */
  prepSourceSec: number | null;
  playing: boolean;
  mediaSeekEpoch: number;
}) {
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

  if (live && wantsReverse && reversed.busy) {
    return <span className="editor-preview-wait muted">Reversing…</span>;
  }
  if (live && wantsReverse && reversed.error) {
    return (
      <span className="editor-preview-status muted">{reversed.error}</span>
    );
  }

  if (kind === "video" && videoSrc) {
    return (
      <PersistentVideo
        src={videoSrc}
        live={live}
        sourceSec={live ? (liveLayer?.sourceSec ?? 0) : (prepSourceSec ?? 0)}
        followLive={live}
        prep={prepSourceSec != null && !live}
        playing={playing}
        mediaSeekEpoch={mediaSeekEpoch}
        clipId={liveLayer?.clip.id ?? null}
      />
    );
  }

  if (imageSrc) {
    return <PersistentImage src={imageSrc} live={live} />;
  }

  if (live && media.waitingLocal) {
    return <span className="editor-preview-wait muted">Saving locally…</span>;
  }
  return null;
}

function PersistentImage({ src, live }: { src: string; live: boolean }) {
  return (
    <img
      className={`editor-preview-media editor-preview-detail${
        live ? "" : " is-standby"
      }`}
      src={src}
      alt=""
      draggable={false}
    />
  );
}

/**
 * One long-lived video for an asset×direction. Visibility / seek / play only —
 * no remount across timeline clips that share this decoder.
 */
function PersistentVideo({
  src,
  live,
  sourceSec,
  followLive,
  prep,
  playing,
  mediaSeekEpoch,
  clipId,
}: {
  src: string;
  live: boolean;
  sourceSec: number;
  followLive: boolean;
  prep: boolean;
  playing: boolean;
  mediaSeekEpoch: number;
  clipId: string | null;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const sourceSecRef = useRef(sourceSec);
  const playingRef = useRef(playing);
  const liveRef = useRef(live);
  const clipIdRef = useRef(clipId);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    sourceSecRef.current = sourceSec;
  }, [sourceSec]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  // Initial attach / src change — decode ready, then seek to commanded time.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    setReady(false);

    const boot = async () => {
      await seekMedia(el, sourceSecRef.current);
      if (cancelled) return;
      await waitForCurrentFrame(el);
      if (cancelled) return;
      setReady(true);
      el.pause();
      if (liveRef.current && playingRef.current) {
        await waitForCanPlay(el);
        if (cancelled || !playingRef.current || !liveRef.current) return;
        void el.play().catch(() => {});
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Prep (non-live): keep parked on the upcoming in-point.
  useEffect(() => {
    if (!prep || live || !ready) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      await seekMedia(el, sourceSec);
      if (cancelled) return;
      await waitForCurrentFrame(el);
      if (cancelled) return;
      el.pause();
    })();
    return () => {
      cancelled = true;
    };
  }, [prep, live, ready, sourceSec]);

  // Live + paused: follow playhead seeks (scrub).
  useEffect(() => {
    if (!live || playing || !ready || !followLive) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      await seekMedia(el, sourceSecRef.current);
      if (cancelled) return;
      await waitForCurrentFrame(el);
      if (cancelled) return;
      el.pause();
    })();
    return () => {
      cancelled = true;
    };
  }, [live, playing, ready, followLive, sourceSec]);

  // Live clip-instance change while playing same asset (can't prep a second
  // decoder): hard-seek to the new in-point, no hold canvas.
  useEffect(() => {
    if (clipIdRef.current === clipId) return;
    const prev = clipIdRef.current;
    clipIdRef.current = clipId;
    if (!live || !ready || prev == null || clipId == null) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      await seekMedia(el, sourceSecRef.current);
      if (cancelled) return;
      await waitForCurrentFrame(el);
      if (cancelled) return;
      if (playingRef.current) {
        await waitForCanPlay(el);
        if (cancelled || !playingRef.current) return;
        void el.play().catch(() => {});
      } else {
        el.pause();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clipId, live, ready]);

  // Become live: reveal + play if timeline is playing. Already pre-seeked when
  // coming from prep on a different asset — just start playback.
  useEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;

    if (!live) {
      el.pause();
      return;
    }

    let cancelled = false;
    void (async () => {
      // Align to live source (prep should already be at in-point).
      if (Math.abs(el.currentTime - sourceSecRef.current) > 0.12) {
        await seekMedia(el, sourceSecRef.current);
        if (cancelled) return;
        await waitForCurrentFrame(el);
        if (cancelled) return;
      }
      if (playingRef.current) {
        await waitForCanPlay(el);
        if (cancelled || !playingRef.current) return;
        void el.play().catch(() => {});
      } else {
        el.pause();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [live, ready, mediaSeekEpoch]);

  // Play / pause while remaining live.
  useEffect(() => {
    const el = ref.current;
    if (!el || !live || !ready) return;
    if (!playing) {
      el.pause();
      return;
    }
    let cancelled = false;
    void (async () => {
      if (Math.abs(el.currentTime - sourceSecRef.current) > 0.25) {
        await seekMedia(el, sourceSecRef.current);
        if (cancelled) return;
      }
      await waitForCanPlay(el);
      if (cancelled || !playingRef.current) return;
      void el.play().catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [playing, live, ready, mediaSeekEpoch]);

  return (
    <video
      ref={ref}
      className={`editor-preview-media editor-preview-detail${
        live && ready ? "" : " is-standby"
      }`}
      src={src}
      playsInline
      preload="auto"
      muted
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
