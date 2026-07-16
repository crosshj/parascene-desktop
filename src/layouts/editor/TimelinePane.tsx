import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCreation } from "../../library/catalogClient";
import { creationPreviewUrl } from "../../library/previewUrl";
import {
  ensureReversedMedia,
  getCachedReversedMedia,
} from "../../library/reversedMedia";
import type { Creation } from "../../library/types";
import type { TimelineClip } from "../../project/types";
import {
  getActiveStagedClipDrag,
  parseStagedClipPayload,
  readStagedClipFromDataTransfer,
  STAGED_CLIP_MIME,
  stagedClipDuration,
  subscribeStagedClipDrag,
  subscribeStagedClipPointer,
  targetLaneForDraft,
  TIMELINE_PX_PER_SEC,
  type StagedClipDraft,
  type TimelineGhostClip,
} from "./stagedClip";
import { timelineSequenceDuration } from "./timelineCompose";

type TimelinePaneProps = {
  clips: TimelineClip[];
  /** Reset local drops when the open project changes. */
  projectId?: string;
  /** Persist timeline clips on the open project. */
  onClipsChange?: (clips: TimelineClip[]) => void;
  /** Currently selected clip ids (multi-select). */
  selectedClipIds?: readonly string[];
  onSelectClip?: (
    clip: TimelineClip | null,
    opts?: { additive?: boolean },
  ) => void;
  /** Timeline zoom multiplier (0.5–3); controlled from project prefs. */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  /** True when the center preview is owned by the timeline. */
  monitorActive?: boolean;
  /** Click/seek on tracks (not clip drag) hands the preview to the timeline. */
  onActivateMonitor?: () => void;
  playheadSec?: number;
  onPlayheadChange?: (sec: number) => void;
  /** Transport — only shown when monitorActive. */
  playing?: boolean;
  onTogglePlay?: () => void;
  volume?: number;
  onVolumeChange?: (volume: number) => void;
  canMergeSelected?: boolean;
  onMergeSelected?: () => void;
  mergeBusy?: boolean;
};

type PointerDropDetail = {
  draft: StagedClipDraft;
  point: { x: number; y: number };
};

const DEFAULT_DURATION_SEC = 60;
const SNAP_THRESHOLD_SEC = 0.75;
/** Pixels before a press becomes a clip move instead of a click-select. */
const CLIP_MOVE_THRESHOLD_PX = 5;

function formatTick(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTransportClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * 24);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

function formatClipDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0.0s";
  return `${(Math.round(sec * 10) / 10).toFixed(1)}s`;
}

function clipDisplayThumbUrl(
  clip: TimelineClip,
  catalogByAssetId: Record<string, string>,
  reverseByAssetId: Record<string, string>,
): string | null {
  const assetId = clip.assetId;
  if (clip.reverse && assetId) {
    return (
      reverseByAssetId[assetId] ||
      clip.thumbUrl ||
      catalogByAssetId[assetId] ||
      null
    );
  }
  if (assetId && catalogByAssetId[assetId]) return catalogByAssetId[assetId];
  return clip.thumbUrl || null;
}

function newClipId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function snapStartSec(
  startSec: number,
  laneClips: TimelineClip[],
  magnetic: boolean,
  excludeIds?: ReadonlySet<string> | string,
): number {
  const raw = Math.max(0, startSec);
  if (!magnetic) return Math.round(raw * 10) / 10;

  const excluded =
    typeof excludeIds === "string"
      ? new Set([excludeIds])
      : (excludeIds ?? new Set<string>());
  const others = excluded.size
    ? laneClips.filter((c) => !excluded.has(c.id))
    : laneClips;
  const anchors = [
    0,
    ...others.map((c) => c.endSec),
    ...others.map((c) => c.startSec),
  ];
  let best = raw;
  let bestDist = SNAP_THRESHOLD_SEC;
  for (const a of anchors) {
    const d = Math.abs(raw - a);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return Math.max(0, Math.round(best * 10) / 10);
}

function draftToClip(
  draft: StagedClipDraft,
  startSec: number,
  lane: "video" | "audio",
): TimelineClip {
  const duration = stagedClipDuration(draft);
  return {
    id: newClipId(),
    label: formatClipDuration(duration),
    startSec,
    endSec: startSec + duration,
    assetId: draft.assetId,
    thumbUrl: draft.thumbUrl,
    lane,
    kind: draft.kind,
    inSec: draft.inSec,
    outSec: draft.outSec,
    includeAudio: draft.includeAudio,
    reverse: draft.reverse,
    transform: draft.transform,
    framing: draft.framing,
  };
}

/** Stable 0–1 noise from a string (deterministic “fake” waveform). */
function hashUnit(seed: string, index: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= index + 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h >>> 0) % 1000) / 1000;
}

/** Full-bleed waveform bars for audio clips on the timeline. */
function ClipAudioWaveform({
  widthPx,
  seed,
}: {
  widthPx: number;
  seed: string;
}) {
  const barW = 2;
  const gap = 2;
  const count = Math.max(12, Math.floor((widthPx - 8) / (barW + gap)));
  const bars = Array.from({ length: count }, (_, i) => {
    const n = hashUnit(seed, i);
    const env = Math.sin((Math.PI * (i + 0.5)) / count);
    return 0.18 + env * (0.35 + n * 0.55);
  });

  return (
    <div className="editor-timeline-clip-wave" aria-hidden>
      <svg
        className="editor-timeline-clip-wave-svg"
        viewBox={`0 0 ${widthPx} 40`}
        preserveAspectRatio="none"
        width={widthPx}
        height="100%"
      >
        {bars.map((amp, i) => {
          const h = Math.max(3, amp * 36);
          const x = 4 + i * (barW + gap);
          const y = (40 - h) / 2;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={1}
            />
          );
        })}
      </svg>
    </div>
  );
}

function MiniClip({
  startSec,
  durationSec,
  thumbUrl,
  label,
  className,
  pxPerSec,
  title,
  moving = false,
  selected = false,
  audio = false,
  reversed = false,
  waveSeed,
  onPointerDown,
}: {
  startSec: number;
  durationSec: number;
  thumbUrl: string | null;
  label?: string;
  className: string;
  pxPerSec: number;
  title?: string;
  moving?: boolean;
  selected?: boolean;
  /** Audio lane / audio kind — draw waveform overlay instead of a thumb. */
  audio?: boolean;
  /** Show a small left-pointing play mark (reversed clip). */
  reversed?: boolean;
  waveSeed?: string;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const safeDuration =
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 1;
  const widthPx = Math.max(4, Math.round(safeDuration * pxPerSec));
  const isGhost = className.includes("ghost");
  const movable = Boolean(onPointerDown) && !isGhost;

  const classNames = [
    className,
    moving ? "is-moving" : "",
    selected ? "is-selected" : "",
    audio ? "is-audio" : "",
    reversed ? "is-reversed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  let background: string | undefined = "rgba(88, 40, 140, 0.92)";
  let border: string | undefined = "1.5px solid #c084fc";
  if (isGhost) {
    background = "rgba(168, 85, 247, 0.22)";
    border = "1.5px dashed #c084fc";
  } else if (moving) {
    background = "rgba(110, 55, 170, 0.96)";
    border = "1.5px solid #e9d5ff";
  } else if (selected) {
    background = undefined;
    border = undefined;
  } else if (audio) {
    background = "rgba(55, 40, 100, 0.94)";
    border = "1.5px solid #a78bfa";
  }

  return (
    <div
      className={classNames}
      title={title}
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        top: 6,
        bottom: 6,
        left: Math.max(0, startSec) * pxPerSec,
        width: widthPx,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: audio ? "2px 6px" : "2px 6px 2px 4px",
        borderRadius: 3,
        overflow: "hidden",
        zIndex: moving ? 4 : selected ? 2 : isGhost ? 3 : 1,
        background,
        border,
        pointerEvents: isGhost ? "none" : "auto",
        cursor: movable ? (moving ? "grabbing" : "grab") : undefined,
        touchAction: movable ? "none" : undefined,
        userSelect: "none",
        opacity: moving ? 0.95 : 1,
        minWidth: 0,
      }}
    >
      {reversed ? (
        <span className="editor-timeline-clip-reverse" aria-hidden title="Reversed">
          <svg viewBox="0 0 8 8" width="7" height="7">
            <path fill="currentColor" d="M7 1v6L1.5 4z" />
          </svg>
        </span>
      ) : null}
      {audio ? (
        <ClipAudioWaveform
          widthPx={widthPx}
          seed={waveSeed ?? label ?? "audio"}
        />
      ) : thumbUrl && widthPx >= 40 ? (
        <img
          className="editor-timeline-clip-thumb"
          src={thumbUrl}
          alt=""
          draggable={false}
          style={{
            width: Math.min(32, Math.max(16, widthPx * 0.35)),
            height: Math.min(32, Math.max(16, widthPx * 0.35)),
            flexShrink: 0,
            objectFit: "cover",
            borderRadius: 2,
            background: "#0a0a0e",
            pointerEvents: "none",
          }}
        />
      ) : !audio && widthPx >= 28 ? (
        <span
          className="editor-timeline-clip-thumb is-empty"
          style={{
            width: 20,
            height: 20,
            flexShrink: 0,
            borderRadius: 2,
            background: "rgba(168, 85, 247, 0.35)",
          }}
        />
      ) : null}
      {widthPx >= 36 ? (
        <span
          className="editor-timeline-clip-dur"
          style={{
            position: audio ? "relative" : undefined,
            zIndex: audio ? 1 : undefined,
            color: "#f0f0f5",
            fontSize: widthPx < 56 ? 11 : 13,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            pointerEvents: "none",
            textShadow: audio ? "0 1px 2px rgba(0,0,0,0.65)" : undefined,
          }}
        >
          {label ?? formatClipDuration(safeDuration)}
        </span>
      ) : null}
    </div>
  );
}

export function TimelinePane({
  clips: seedClips,
  projectId = "",
  onClipsChange,
  selectedClipIds = [],
  onSelectClip,
  zoom: zoomProp = 1,
  onZoomChange,
  monitorActive = false,
  onActivateMonitor,
  playheadSec = 0,
  onPlayheadChange,
  playing = false,
  onTogglePlay,
  volume = 80,
  onVolumeChange,
  canMergeSelected = false,
  onMergeSelected,
  mergeBusy = false,
}: TimelinePaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [clips, setClips] = useState<TimelineClip[]>(seedClips);
  const [ghost, setGhost] = useState<TimelineGhostClip | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [movingClipIds, setMovingClipIds] = useState<string[]>([]);
  const [magnetic, setMagnetic] = useState(true);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [thumbByAssetId, setThumbByAssetId] = useState<Record<string, string>>(
    {},
  );
  const [reverseThumbByAssetId, setReverseThumbByAssetId] = useState<
    Record<string, string>
  >({});
  const zoom = zoomProp;
  const setZoom = useCallback(
    (next: number | ((prev: number) => number)) => {
      const value = typeof next === "function" ? next(zoom) : next;
      onZoomChange?.(value);
    },
    [onZoomChange, zoom],
  );
  const moveRef = useRef<{
    /** Clip under the pointer (snap + grab offset). */
    primaryId: string;
    movingIds: string[];
    /** startSec at arm time, keyed by clip id. */
    originStarts: Record<string, number>;
    /** duration keyed by clip id. */
    durations: Record<string, number>;
    grabOffsetSec: number;
    pointerId: number;
  } | null>(null);
  const pressRef = useRef<{
    clip: TimelineClip;
    pointerId: number;
    startX: number;
    startY: number;
    armed: boolean;
    additive: boolean;
  } | null>(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const selectedClipIdsRef = useRef(selectedClipIds);
  selectedClipIdsRef.current = selectedClipIds;
  const onClipsChangeRef = useRef(onClipsChange);
  onClipsChangeRef.current = onClipsChange;
  const onSelectClipRef = useRef(onSelectClip);
  onSelectClipRef.current = onSelectClip;
  const onActivateMonitorRef = useRef(onActivateMonitor);
  onActivateMonitorRef.current = onActivateMonitor;
  const onPlayheadChangeRef = useRef(onPlayheadChange);
  onPlayheadChangeRef.current = onPlayheadChange;
  const magneticRef = useRef(magnetic);
  magneticRef.current = magnetic;
  const pxPerSecRef = useRef(TIMELINE_PX_PER_SEC * zoom);
  const seekRef = useRef<{ pointerId: number } | null>(null);

  const commitClips = useCallback((next: TimelineClip[]) => {
    setClips(next);
    clipsRef.current = next;
    onClipsChangeRef.current?.(next);
  }, []);

  useEffect(() => {
    if (moveRef.current) return;
    setClips(seedClips);
    clipsRef.current = seedClips;
  }, [projectId, seedClips]);

  const clipAssetIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const clip of clips) {
      if (clip.assetId) ids.add(clip.assetId);
    }
    return [...ids].sort().join("\0");
  }, [clips]);

  const reversedVideoAssetIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const clip of clips) {
      if (clip.reverse && clip.kind !== "audio" && clip.assetId) {
        ids.add(clip.assetId);
      }
    }
    return [...ids].sort().join("\0");
  }, [clips]);

  useEffect(() => {
    const ids = clipAssetIdsKey ? clipAssetIdsKey.split("\0") : [];
    if (ids.length === 0) {
      setThumbByAssetId({});
      return;
    }

    let cancelled = false;

    const load = async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            const row = await getCreation(id);
            const url = creationPreviewUrl(row);
            if (url) next[id] = url;
          } catch {
            // Missing catalog rows keep the stored clip.thumbUrl fallback.
          }
        }),
      );
      if (!cancelled) setThumbByAssetId(next);
    };

    void load();

    let unlisten: (() => void) | undefined;
    void listen<Creation>("library-creation-updated", (event) => {
      const row = event.payload;
      if (!ids.includes(row.id)) return;
      const url = creationPreviewUrl(row);
      setThumbByAssetId((prev) => {
        if (!url) {
          if (!(row.id in prev)) return prev;
          const { [row.id]: _, ...rest } = prev;
          return rest;
        }
        if (prev[row.id] === url) return prev;
        return { ...prev, [row.id]: url };
      });
    }).then((off) => {
      unlisten = off;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [clipAssetIdsKey]);

  useEffect(() => {
    const ids = reversedVideoAssetIdsKey
      ? reversedVideoAssetIdsKey.split("\0")
      : [];
    if (ids.length === 0) {
      setReverseThumbByAssetId({});
      return;
    }

    let cancelled = false;

    const load = async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        ids.map(async (id) => {
          const cached = getCachedReversedMedia(id);
          if (cached?.thumbUrl) {
            next[id] = cached.thumbUrl;
            return;
          }
          try {
            const urls = await ensureReversedMedia(id);
            if (urls.thumbUrl) next[id] = urls.thumbUrl;
          } catch {
            // Keep clip.thumbUrl / catalog fallback.
          }
        }),
      );
      if (cancelled) return;
      setReverseThumbByAssetId(next);

      // Persist reverse first-frame thumbs onto clips that still hold the original.
      const current = clipsRef.current;
      const patched = current.map((clip) => {
        if (!clip.reverse || !clip.assetId) return clip;
        const thumb = next[clip.assetId];
        if (!thumb || clip.thumbUrl === thumb) return clip;
        return { ...clip, thumbUrl: thumb };
      });
      const changed = patched.some(
        (c, i) => c.thumbUrl !== current[i]?.thumbUrl,
      );
      if (changed) commitClips(patched);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [reversedVideoAssetIdsKey, commitClips]);

  useEffect(() => {
    return subscribeStagedClipDrag((draft) => {
      setDragActive(draft !== null);
      if (!draft) setGhost(null);
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const sync = () => setViewportWidth(Math.floor(el.clientWidth));
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pxPerSec = TIMELINE_PX_PER_SEC * zoom;
  pxPerSecRef.current = pxPerSec;
  const endSec = clips.reduce((max, c) => Math.max(max, c.endSec), 0);
  const contentDurationSec = Math.max(
    DEFAULT_DURATION_SEC,
    Math.ceil(endSec / 10) * 10 + 10,
  );
  const contentWidth = contentDurationSec * pxPerSec;
  const trackWidth = Math.max(contentWidth, viewportWidth);
  const rulerDurationSec = trackWidth / pxPerSec;
  const ticks: number[] = [];
  for (let t = 0; t <= rulerDurationSec + 0.001; t += 10) {
    ticks.push(t);
  }
  const minorTicks: number[] = [];
  for (let t = 0; t <= rulerDurationSec + 0.001; t += 1) {
    if (t % 10 !== 0) minorTicks.push(t);
  }

  const videoClips = clips.filter((c) => (c.lane ?? "video") === "video");
  const audioClips = clips.filter((c) => c.lane === "audio");

  const pointToStartSec = useCallback(
    (clientX: number) => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return 0;
      const x =
        clientX - scrollEl.getBoundingClientRect().left + scrollEl.scrollLeft;
      return Math.max(0, x / pxPerSecRef.current);
    },
    [],
  );

  const seekPlayhead = useCallback(
    (clientX: number) => {
      const next = pointToStartSec(clientX);
      onPlayheadChangeRef.current?.(next);
    },
    [pointToStartSec],
  );

  const beginRulerSeek = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (getActiveStagedClipDrag()) return;
      event.preventDefault();
      event.stopPropagation();
      seekRef.current = { pointerId: event.pointerId };
      onActivateMonitorRef.current?.();
      seekPlayhead(event.clientX);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // window listeners still handle move/up
      }
    },
    [seekPlayhead],
  );

  const applyClipMove = useCallback(
    (clientX: number, finalize: boolean) => {
      const move = moveRef.current;
      if (!move) return;
      const primaryOrigin = move.originStarts[move.primaryId];
      const primaryDuration = move.durations[move.primaryId];
      if (!Number.isFinite(primaryOrigin) || !Number.isFinite(primaryDuration)) {
        return;
      }

      const rawPrimaryStart = pointToStartSec(clientX) - move.grabOffsetSec;
      const primaryClip = clipsRef.current.find((c) => c.id === move.primaryId);
      const lane: "video" | "audio" =
        primaryClip?.lane === "audio" ? "audio" : "video";
      const laneClips = clipsRef.current.filter((c) =>
        lane === "audio"
          ? c.lane === "audio"
          : (c.lane ?? "video") === "video",
      );
      const exclude = new Set(move.movingIds);
      const snappedPrimary = snapStartSec(
        rawPrimaryStart,
        laneClips,
        finalize ? magneticRef.current : magneticRef.current,
        exclude,
      );
      const delta = snappedPrimary - primaryOrigin;

      setClips((prev) => {
        const next = prev.map((c) => {
          if (!exclude.has(c.id)) return c;
          const origin = move.originStarts[c.id];
          const duration = move.durations[c.id];
          if (!Number.isFinite(origin) || !Number.isFinite(duration)) return c;
          const startSec = Math.max(0, origin + delta);
          return {
            ...c,
            startSec,
            endSec: startSec + duration,
          };
        });
        clipsRef.current = next;
        return next;
      });
    },
    [pointToStartSec],
  );

  const endClipMove = useCallback(
    (clientX: number) => {
      if (!moveRef.current) return;
      applyClipMove(clientX, true);
      const next = clipsRef.current;
      moveRef.current = null;
      setMovingClipIds([]);
      document.body.classList.remove("is-timeline-clip-moving");
      onClipsChangeRef.current?.(next);
    },
    [applyClipMove],
  );

  const armClipMove = useCallback(
    (clip: TimelineClip, clientX: number, pointerId: number) => {
      const selected = selectedClipIdsRef.current;
      const movingIds =
        selected.includes(clip.id) && selected.length > 0
          ? [...selected]
          : [clip.id];
      // Dragging an unselected clip adopts it as the sole selection.
      if (!selected.includes(clip.id)) {
        onSelectClipRef.current?.(clip);
      }
      const originStarts: Record<string, number> = {};
      const durations: Record<string, number> = {};
      for (const c of clipsRef.current) {
        if (!movingIds.includes(c.id)) continue;
        originStarts[c.id] = c.startSec;
        durations[c.id] = Math.max(0.1, c.endSec - c.startSec);
      }
      const pointerSec = pointToStartSec(clientX);
      moveRef.current = {
        primaryId: clip.id,
        movingIds,
        originStarts,
        durations,
        grabOffsetSec: pointerSec - clip.startSec,
        pointerId,
      };
      setMovingClipIds(movingIds);
      document.body.classList.add("is-timeline-clip-moving");
    },
    [pointToStartSec],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const seek = seekRef.current;
      if (seek && event.pointerId === seek.pointerId) {
        event.preventDefault();
        seekPlayhead(event.clientX);
        return;
      }

      const press = pressRef.current;
      if (press && event.pointerId === press.pointerId && !press.armed) {
        const dx = event.clientX - press.startX;
        const dy = event.clientY - press.startY;
        if (Math.hypot(dx, dy) >= CLIP_MOVE_THRESHOLD_PX) {
          press.armed = true;
          armClipMove(press.clip, press.startX, press.pointerId);
        }
      }

      const move = moveRef.current;
      if (!move || event.pointerId !== move.pointerId) return;
      event.preventDefault();
      applyClipMove(event.clientX, false);
    };
    const onUp = (event: PointerEvent) => {
      if (seekRef.current && event.pointerId === seekRef.current.pointerId) {
        seekRef.current = null;
        return;
      }

      const press = pressRef.current;
      if (press && event.pointerId === press.pointerId) {
        pressRef.current = null;
        if (!press.armed && !moveRef.current) {
          onSelectClipRef.current?.(press.clip, {
            additive: press.additive,
          });
          return;
        }
      }

      const move = moveRef.current;
      if (!move || event.pointerId !== move.pointerId) return;
      endClipMove(event.clientX);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [applyClipMove, armClipMove, endClipMove, seekPlayhead]);

  const beginClipPress = useCallback(
    (clip: TimelineClip, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (getActiveStagedClipDrag()) return;
      event.preventDefault();
      event.stopPropagation();
      pressRef.current = {
        clip,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        armed: false,
        additive: event.shiftKey,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // window listeners still handle move/up
      }
    },
    [],
  );

  const isOverTracks = useCallback((clientX: number, clientY: number) => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return false;
    const rect = scrollEl.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }, []);

  const placeDraftAt = useCallback(
    (draft: StagedClipDraft, clientX: number, clientY: number) => {
      if (!isOverTracks(clientX, clientY)) return;
      const lane = targetLaneForDraft(draft);
      const laneClips = clips.filter((c) =>
        lane === "audio"
          ? c.lane === "audio"
          : (c.lane ?? "video") === "video",
      );
      const startSec = snapStartSec(
        pointToStartSec(clientX),
        laneClips,
        magnetic,
      );
      commitClips([...clips, draftToClip(draft, startSec, lane)]);
      setGhost(null);
    },
    [clips, commitClips, isOverTracks, magnetic, pointToStartSec],
  );

  const syncGhostFromPoint = useCallback(
    (clientX: number, clientY: number) => {
      const draft = getActiveStagedClipDrag();
      if (!draft || !isOverTracks(clientX, clientY)) {
        setGhost(null);
        return;
      }
      const lane = targetLaneForDraft(draft);
      const laneClips = clips.filter((c) =>
        lane === "audio"
          ? c.lane === "audio"
          : (c.lane ?? "video") === "video",
      );
      const startSec = snapStartSec(
        pointToStartSec(clientX),
        laneClips,
        magnetic,
      );
      setGhost({
        startSec,
        durationSec: stagedClipDuration(draft),
        lane,
        label: draft.label,
        thumbUrl: draft.thumbUrl,
      });
    },
    [clips, isOverTracks, magnetic, pointToStartSec],
  );

  useEffect(() => {
    return subscribeStagedClipPointer((point) => {
      if (!point) {
        setGhost(null);
        return;
      }
      syncGhostFromPoint(point.x, point.y);
    });
  }, [syncGhostFromPoint]);

  useEffect(() => {
    const onPointerDrop = (event: Event) => {
      const custom = event as CustomEvent<PointerDropDetail>;
      const detail = custom.detail;
      if (!detail?.draft || !detail.point) return;
      placeDraftAt(detail.draft, detail.point.x, detail.point.y);
    };
    window.addEventListener("parascene-staged-clip-drop", onPointerDrop);
    return () => {
      window.removeEventListener("parascene-staged-clip-drop", onPointerDrop);
    };
  }, [placeDraftAt]);

  const isStagedClipDrag = useCallback((event: DragEvent) => {
    if (getActiveStagedClipDrag()) return true;
    const types = Array.from(event.dataTransfer.types);
    return (
      types.includes(STAGED_CLIP_MIME) ||
      types.includes("text/plain") ||
      types.includes("Text")
    );
  }, []);

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isStagedClipDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    syncGhostFromPoint(event.clientX, event.clientY);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setGhost(null);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isStagedClipDrag(event)) return;
    event.preventDefault();
    const draft =
      readStagedClipFromDataTransfer(event.dataTransfer) ??
      parseStagedClipPayload(event.dataTransfer.getData("text/plain")) ??
      getActiveStagedClipDrag();
    setGhost(null);
    if (!draft) return;
    placeDraftAt(draft, event.clientX, event.clientY);
  };

  const dragging =
    ghost !== null || dragActive || movingClipIds.length > 0;

  const sequenceEndSec = timelineSequenceDuration(clips);
  const transportSpanSec = Math.max(sequenceEndSec, playheadSec, 0.1);
  const canPlayTransport = Boolean(onTogglePlay) && sequenceEndSec > 0;
  const transportEnabled = monitorActive;
  const seekTransportTo = (sec: number) => {
    if (!onPlayheadChange) return;
    onPlayheadChange(Math.max(0, Math.min(transportSpanSec, sec)));
  };
  const seekTransportBy = (delta: number) => {
    seekTransportTo(playheadSec + delta);
  };

  const paneClass = [
    "editor-timeline-pane",
    dragging ? "is-clip-dragging" : "",
    monitorActive ? "is-monitor-active" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section
      className={paneClass}
      aria-label="Timeline"
      data-monitor-active={monitorActive ? "true" : undefined}
    >
      <div
        className="editor-timeline-head"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          onActivateMonitor?.();
        }}
      >
        <div className="editor-timeline-title">
          <h2>Timeline</h2>
        </div>

        <div
          className={`editor-timeline-transport${
            transportEnabled ? "" : " is-inactive"
          }`}
          aria-label="Timeline playback"
          aria-disabled={!transportEnabled}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="editor-transport-tc">
            {formatTransportClock(playheadSec)}
          </span>
          <div
            className="editor-transport-icons"
            aria-label="Playback controls"
          >
            <button
              type="button"
              className="editor-transport-icon"
              disabled={!transportEnabled || !onPlayheadChange}
              title="Skip back"
              aria-label="Skip to beginning"
              onClick={() => seekTransportTo(0)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path
                  fill="currentColor"
                  d="M2 3h1.5v10H2zm3.2 5 8.3 5.2V2.8z"
                />
              </svg>
            </button>
            <button
              type="button"
              className="editor-transport-icon"
              disabled={!transportEnabled || !onPlayheadChange}
              title="Rewind"
              aria-label="Rewind 1 second"
              onClick={() => seekTransportBy(-1)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path
                  fill="currentColor"
                  d="M8.2 8 14.5 3v10zm-6.7 0L7.8 3v10z"
                />
              </svg>
            </button>
            <button
              type="button"
              className="editor-transport-icon is-play"
              disabled={!transportEnabled || !canPlayTransport}
              title={playing ? "Pause" : "Play"}
              aria-label={playing ? "Pause" : "Play"}
              onClick={() => onTogglePlay?.()}
            >
              {playing ? (
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M4 3h3v10H4zm5 0h3v10H9z"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
                  <path fill="currentColor" d="M4 2.5v11l10-5.5z" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="editor-transport-icon"
              disabled={!transportEnabled || !onPlayheadChange}
              title="Fast forward"
              aria-label="Forward 1 second"
              onClick={() => seekTransportBy(1)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path
                  fill="currentColor"
                  d="M1.5 3v10L7.8 8zm6.7 0v10L14.5 8z"
                />
              </svg>
            </button>
            <button
              type="button"
              className="editor-transport-icon"
              disabled={!transportEnabled || !onPlayheadChange}
              title="Skip forward"
              aria-label="Skip to end"
              onClick={() => seekTransportTo(transportSpanSec)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path
                  fill="currentColor"
                  d="M2.5 2.8v10.4L10.8 8zM12.5 3H14v10h-1.5z"
                />
              </svg>
            </button>
          </div>
          <label
            className={`editor-transport-volume${
              transportEnabled ? "" : " is-disabled"
            }`}
          >
            <svg
              className="editor-transport-volume-icon"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-hidden
            >
              <path
                fill="currentColor"
                d="M2 6h3l3-3v10L5 10H2zm8.2 1.2a2.2 2.2 0 0 1 0 1.6l-.8-.5a1.2 1.2 0 0 0 0-.6zm1.6-2a4.2 4.2 0 0 1 0 5.6l-.8-.5a3.2 3.2 0 0 0 0-4.6z"
              />
            </svg>
            <span className="visually-hidden">Volume</span>
            <input
              type="range"
              className="editor-transport-scrub"
              min={0}
              max={100}
              value={volume}
              disabled={!transportEnabled}
              aria-label="Volume"
              style={
                {
                  ["--scrub-progress" as string]: `${volume}%`,
                } as CSSProperties
              }
              onChange={(event) => {
                if (!transportEnabled) return;
                onVolumeChange?.(Number(event.target.value));
              }}
            />
          </label>
        </div>

        <div
          className="editor-timeline-tools"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="editor-timeline-tool"
            title={
              canMergeSelected
                ? "Merge selected clips"
                : "Select contiguous video clips to merge"
            }
            aria-label="Merge selected clips"
            disabled={!canMergeSelected || mergeBusy}
            onClick={() => onMergeSelected?.()}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.5 4.5h4v7h-4zm7 0h4v7h-4zM6.5 8h3"
              />
            </svg>
          </button>
          <button
            type="button"
            className={
              magnetic
                ? "editor-timeline-tool is-active"
                : "editor-timeline-tool"
            }
            title="Magnetic snapping"
            aria-label="Toggle magnetic snapping"
            aria-pressed={magnetic}
            onClick={() => setMagnetic((v) => !v)}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                d="M3.5 2.5h3v5a2.5 2.5 0 1 0 5 0v-5h3M3.5 14.5h9"
              />
            </svg>
          </button>
          <button
            type="button"
            className="editor-timeline-tool"
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() =>
              setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))
            }
          >
            <span aria-hidden>−</span>
          </button>
          <input
            type="range"
            className="editor-timeline-zoom"
            min={0.5}
            max={3}
            step={0.25}
            value={zoom}
            aria-label="Timeline zoom"
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          <button
            type="button"
            className="editor-timeline-tool"
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() =>
              setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))
            }
          >
            <span aria-hidden>+</span>
          </button>
        </div>
      </div>

      <div className="editor-timeline-body">
        <div className="editor-timeline-labels" aria-hidden>
          <div className="editor-timeline-label-spacer" />
          <div className="editor-timeline-label">V1</div>
          <div className="editor-timeline-label">A1</div>
        </div>

        <div
          ref={scrollRef}
          className="editor-timeline-scroll"
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <div
            className="editor-timeline-tracks"
            style={{ width: trackWidth }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const target = event.target as HTMLElement | null;
              if (target?.closest(".editor-timeline-clip")) return;
              if (target?.closest(".editor-timeline-ruler")) return;
              onActivateMonitor?.();
              onSelectClip?.(null);
            }}
          >
            <div
              className="editor-timeline-ruler"
              role="slider"
              tabIndex={0}
              aria-label="Timeline playhead"
              aria-valuemin={0}
              aria-valuenow={Math.round(playheadSec * 100) / 100}
              aria-valuetext={formatTick(playheadSec)}
              onPointerDown={beginRulerSeek}
            >
              {minorTicks.map((t) => (
                <span
                  key={`m-${t}`}
                  className="editor-timeline-tick-minor"
                  style={{ left: t * pxPerSec }}
                />
              ))}
              {ticks.map((t) => (
                <span
                  key={t}
                  className="editor-timeline-tick"
                  style={{ left: t * pxPerSec }}
                >
                  {formatTick(t)}
                </span>
              ))}
            </div>

            <div
              className="editor-timeline-playhead"
              style={{ left: playheadSec * pxPerSec }}
              aria-hidden
            />

            <div className="editor-timeline-lane is-video" aria-label="Video lane">
              {videoClips.length === 0 && !ghost ? (
                <div className="editor-timeline-lane-empty muted">
                  Drop image here
                </div>
              ) : (
                videoClips.map((clip) => (
                  <MiniClip
                    key={clip.id}
                    className="editor-timeline-clip"
                    startSec={clip.startSec}
                    durationSec={clip.endSec - clip.startSec}
                    thumbUrl={clipDisplayThumbUrl(
                      clip,
                      thumbByAssetId,
                      reverseThumbByAssetId,
                    )}
                    label={clip.label}
                    title={clip.assetId ?? clip.label}
                    pxPerSec={pxPerSec}
                    moving={movingClipIds.includes(clip.id)}
                    selected={selectedClipIds.includes(clip.id)}
                    reversed={Boolean(clip.reverse)}
                    onPointerDown={(event) => beginClipPress(clip, event)}
                  />
                ))
              )}
              {ghost?.lane === "video" ? (
                <MiniClip
                  className="editor-timeline-ghost-clip"
                  startSec={ghost.startSec}
                  durationSec={ghost.durationSec}
                  thumbUrl={ghost.thumbUrl}
                  pxPerSec={pxPerSec}
                />
              ) : null}
            </div>

            <div
              className="editor-timeline-lane is-audio"
              aria-label="Master audio lane"
            >
              {audioClips.length === 0 && !ghost ? (
                <div className="editor-timeline-lane-empty muted">
                  Master Audio
                </div>
              ) : (
                audioClips.map((clip) => (
                  <MiniClip
                    key={clip.id}
                    className="editor-timeline-clip"
                    startSec={clip.startSec}
                    durationSec={clip.endSec - clip.startSec}
                    thumbUrl={clipDisplayThumbUrl(
                      clip,
                      thumbByAssetId,
                      reverseThumbByAssetId,
                    )}
                    label={clip.label}
                    title={clip.assetId ?? clip.label}
                    pxPerSec={pxPerSec}
                    moving={movingClipIds.includes(clip.id)}
                    selected={selectedClipIds.includes(clip.id)}
                    audio
                    reversed={Boolean(clip.reverse)}
                    waveSeed={clip.id}
                    onPointerDown={(event) => beginClipPress(clip, event)}
                  />
                ))
              )}
              {ghost?.lane === "audio" ? (
                <MiniClip
                  className="editor-timeline-ghost-clip"
                  startSec={ghost.startSec}
                  durationSec={ghost.durationSec}
                  thumbUrl={ghost.thumbUrl}
                  pxPerSec={pxPerSec}
                  audio
                  waveSeed={`ghost-${ghost.label}`}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
