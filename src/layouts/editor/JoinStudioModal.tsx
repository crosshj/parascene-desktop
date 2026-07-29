import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractVideoFrame } from "../../lab/audioTools";
import {
  ensureLocal,
  getCreations,
  joinTimelineBake,
  joinTimelinePreview,
  type JoinProgress,
  type JoinStrategyInput,
} from "../../library/catalogClient";
import type { TimelineClip } from "../../project/types";
import {
  clipInSec,
  clipOutSec,
  defaultJoinStudioParams,
  effectiveTrim,
  JOIN_PREVIEW_HALF_WINDOW_SEC,
  joinParamsFingerprint,
  joinReplacementSpan,
  type JoinFillFrom,
  type JoinHoldSide,
  type JoinableTimelinePair,
  type JoinStrategy,
  type JoinStudioParams,
} from "./joinStudio";

export type JoinStudioViewTab = "onion" | "side" | "final";

type JoinStudioModalProps = {
  pair: JoinableTimelinePair;
  onDone: () => void;
  onCommitted: (creationId: string, params: JoinStudioParams) => void;
};

function mediaUrlFor(path: string): string {
  return convertFileSrc(path, "media");
}

function decodeImage(url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

function toStrategyInput(params: JoinStudioParams): JoinStrategyInput {
  return {
    strategy: params.strategy,
    nudgeAOutFrames: params.nudgeAOutFrames,
    nudgeBInFrames: params.nudgeBInFrames,
    holdSide: params.holdSide,
    holdFrames: params.holdFrames,
    removeGap: params.removeGap,
    fillFrom: params.fillFrom,
    fillFrames: params.fillFrames,
    xfadeFrames: params.xfadeFrames,
  };
}

function clipPayload(clip: TimelineClip): {
  assetId: string;
  inSec: number;
  outSec: number;
  reverse: boolean;
} {
  return {
    assetId: clip.assetId ?? "",
    inSec: clipInSec(clip),
    outSec: clipOutSec(clip),
    reverse: Boolean(clip.reverse),
  };
}

function Stepper({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <label className="join-studio-stepper">
      <span>{label}</span>
      <span className="join-studio-stepper-controls">
        <button
          type="button"
          disabled={disabled || (min != null && value <= min)}
          onClick={() =>
            onChange(min != null ? Math.max(min, value - 1) : value - 1)
          }
        >
          −
        </button>
        <span className="join-studio-stepper-value">{value}f</span>
        <button
          type="button"
          disabled={disabled || (max != null && value >= max)}
          onClick={() =>
            onChange(max != null ? Math.min(max, value + 1) : value + 1)
          }
        >
          +
        </button>
      </span>
    </label>
  );
}

export function JoinStudioModal({
  pair,
  onDone,
  onCommitted,
}: JoinStudioModalProps) {
  const baseline = useMemo(
    () => defaultJoinStudioParams(pair.gapSec),
    [pair.gapSec],
  );
  const [params, setParams] = useState<JoinStudioParams>(baseline);
  const [viewTab, setViewTab] = useState<JoinStudioViewTab>("final");
  const [onionOpacity, setOnionOpacity] = useState(50);
  const [frameAUrl, setFrameAUrl] = useState<string | null>(null);
  const [frameBUrl, setFrameBUrl] = useState<string | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  const [framesError, setFramesError] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFingerprint, setPreviewFingerprint] = useState<string | null>(
    null,
  );
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitProgress, setCommitProgress] = useState<JoinProgress | null>(
    null,
  );
  const [commitError, setCommitError] = useState<string | null>(null);
  const previewGenRef = useRef(0);
  const locked = committing;

  const currentFingerprint = joinParamsFingerprint(params);
  const previewFresh =
    previewFingerprint != null &&
    previewFingerprint === currentFingerprint &&
    Boolean(previewUrl);
  const previewStale = Boolean(previewUrl) && !previewFresh;

  const aTrim = effectiveTrim(pair.clipA, "A", params);
  const bTrim = effectiveTrim(pair.clipB, "B", params);
  const span = joinReplacementSpan(pair, params);
  const framesReady = Boolean(frameAUrl && frameBUrl);

  const updateParams = useCallback((patch: Partial<JoinStudioParams>) => {
    setParams((prev) => ({ ...prev, ...patch }));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<JoinProgress>("library-join-progress", (event) => {
      setCommitProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const runPreview = useCallback(
    async (next: JoinStudioParams) => {
      const gen = ++previewGenRef.current;
      setPreviewBusy(true);
      setPreviewError(null);
      try {
        const result = await joinTimelinePreview({
          clipA: clipPayload(pair.clipA),
          clipB: clipPayload(pair.clipB),
          strategy: toStrategyInput(next),
          previewHalfWindowSec: JOIN_PREVIEW_HALF_WINDOW_SEC,
        });
        if (gen !== previewGenRef.current) return;
        setPreviewPath(result.path);
        setPreviewUrl(mediaUrlFor(result.path));
        setPreviewFingerprint(joinParamsFingerprint(next));
        setViewTab("final");
      } catch (error) {
        if (gen !== previewGenRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setPreviewError(message);
      } finally {
        if (gen === previewGenRef.current) setPreviewBusy(false);
      }
    },
    [pair.clipA, pair.clipB],
  );

  useEffect(() => {
    // Defer so setState inside runPreview is not synchronous in the effect body.
    const timer = window.setTimeout(() => {
      void runPreview(baseline);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setFramesLoading(true);
      setFramesError(null);
      try {
        const ids = [pair.clipA.assetId, pair.clipB.assetId].filter(
          (id): id is string => Boolean(id),
        );
        await ensureLocal(ids, { fullMedia: true, urgent: true });
        const rows = await getCreations(ids);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const pathA = byId.get(pair.clipA.assetId ?? "")?.localPath;
        const pathB = byId.get(pair.clipB.assetId ?? "")?.localPath;
        if (!pathA || !pathB) {
          throw new Error("Local media missing for one or both clips");
        }
        const timeA = Math.max(0, aTrim.outSec - 1 / 30);
        const timeB = Math.max(0, bTrim.inSec);
        const [fa, fb] = await Promise.all([
          extractVideoFrame({ sourcePath: pathA, timeSec: timeA }),
          extractVideoFrame({ sourcePath: pathB, timeSec: timeB }),
        ]);
        if (cancelled) return;
        // Decode before swapping so the stage never paints an empty <img>.
        await Promise.all([decodeImage(fa.mediaUrl), decodeImage(fb.mediaUrl)]);
        if (cancelled) return;
        setFrameAUrl(fa.mediaUrl);
        setFrameBUrl(fb.mediaUrl);
      } catch (error) {
        if (cancelled) return;
        setFramesError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (!cancelled) setFramesLoading(false);
      }
    };
    // Coalesce rapid nudges into one extract pass.
    const timer = window.setTimeout(() => {
      void load();
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pair.clipA.assetId, pair.clipB.assetId, aTrim.outSec, bTrim.inSec]);

  useEffect(() => {
    if (locked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [locked, onDone]);

  const onReset = () => {
    setParams(baseline);
    void runPreview(baseline);
  };

  const onCommit = async () => {
    if (!previewFresh || locked) return;
    setCommitError(null);
    setCommitting(true);
    setCommitProgress({ phase: "prepare", done: 0, total: 2 });
    try {
      const creation = await joinTimelineBake({
        clipA: clipPayload(pair.clipA),
        clipB: clipPayload(pair.clipB),
        strategy: toStrategyInput(params),
      });
      onCommitted(creation.id, params);
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error));
      setCommitting(false);
      setCommitProgress(null);
    }
  };

  const commitLabel = (() => {
    if (!commitProgress) return "Starting join…";
    if (commitProgress.phase === "prepare") {
      return `Preparing clips ${commitProgress.done}/${commitProgress.total}…`;
    }
    if (commitProgress.phase === "join") return "Baking join with FFmpeg…";
    if (commitProgress.phase === "catalog") return "Saving to library…";
    return "Working…";
  })();

  return (
    <div
      className="confirm-dialog-backdrop join-studio-backdrop"
      role="presentation"
      onClick={() => {
        if (!locked) onDone();
      }}
    >
      <div
        className="join-studio-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="join-studio-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="join-studio-header">
          <h2 id="join-studio-title">Join Studio</h2>
          <p className="join-studio-sub">
            Export-true seam check (±{JOIN_PREVIEW_HALF_WINDOW_SEC}s). Timeline
            monitor black flashes can be browser handoff noise — trust Final
            render here.
            {pair.gapSec > 0.001
              ? ` Gap on timeline: ${pair.gapSec.toFixed(2)}s.`
              : null}
          </p>
        </header>

        <div className="join-studio-tabs" role="tablist">
          {(
            [
              ["onion", "Onion overlay"],
              ["side", "Side by side"],
              ["final", "Final render"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={viewTab === id}
              className={
                viewTab === id
                  ? "join-studio-tab is-active"
                  : "join-studio-tab"
              }
              onClick={() => setViewTab(id)}
            >
              {label}
              {id === "final" && previewStale ? (
                <span className="join-studio-stale-dot" title="Preview outdated" />
              ) : null}
            </button>
          ))}
        </div>

        <div className="join-studio-stage">
          {viewTab === "final" ? (
            <div className="join-studio-final">
              {previewBusy ? (
                <div className="join-studio-stage-message">
                  <span className="confirm-dialog-spinner" aria-hidden />
                  Encoding export preview…
                </div>
              ) : previewError ? (
                <div className="join-studio-stage-message is-error">
                  {previewError}
                </div>
              ) : previewUrl ? (
                <>
                  <video
                    key={previewPath ?? previewUrl}
                    className="join-studio-video"
                    src={previewUrl}
                    controls
                    playsInline
                    autoPlay
                    loop
                  />
                  {previewStale ? (
                    <div className="join-studio-stale-banner">
                      Preview outdated — Re-render
                    </div>
                  ) : (
                    <div className="join-studio-final-caption">
                      Export preview · through the cut
                    </div>
                  )}
                </>
              ) : (
                <div className="join-studio-stage-message">
                  No preview yet — Re-render
                </div>
              )}
            </div>
          ) : null}

          {viewTab === "side" ? (
            framesReady ? (
              <div className="join-studio-side">
                <figure>
                  <img src={frameAUrl ?? undefined} alt="Clip A out" />
                  <figcaption>A out · {aTrim.outSec.toFixed(3)}s</figcaption>
                </figure>
                <figure>
                  <img src={frameBUrl ?? undefined} alt="Clip B in" />
                  <figcaption>B in · {bTrim.inSec.toFixed(3)}s</figcaption>
                </figure>
              </div>
            ) : (
              <div
                className={
                  framesError
                    ? "join-studio-stage-message is-error"
                    : "join-studio-stage-message"
                }
              >
                {framesError ?? "Loading boundary frames…"}
              </div>
            )
          ) : null}

          {viewTab === "onion" ? (
            framesReady ? (
              <div className="join-studio-onion">
                <div className="join-studio-onion-stack">
                  <img
                    src={frameAUrl ?? undefined}
                    alt="Clip A out"
                    style={{ opacity: 1 - onionOpacity / 100 }}
                  />
                  <img
                    src={frameBUrl ?? undefined}
                    alt="Clip B in"
                    style={{ opacity: onionOpacity / 100 }}
                  />
                </div>
                <label className="join-studio-onion-scrub">
                  <span>A</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={onionOpacity}
                    onChange={(event) =>
                      setOnionOpacity(Number(event.target.value))
                    }
                  />
                  <span>B</span>
                </label>
              </div>
            ) : (
              <div
                className={
                  framesError
                    ? "join-studio-stage-message is-error"
                    : "join-studio-stage-message"
                }
              >
                {framesError ?? "Loading boundary frames…"}
              </div>
            )
          ) : null}

          {viewTab !== "final" && framesReady && framesLoading ? (
            <span className="join-studio-refresh-badge">
              <span className="confirm-dialog-spinner" aria-hidden />
              Updating frames…
            </span>
          ) : null}
        </div>

        <div className="join-studio-controls">
          <div className="join-studio-strategy">
            <span className="join-studio-controls-label">Strategy</span>
            <div className="join-studio-strategy-options">
              {(
                [
                  ["hard_cut", "Hard cut"],
                  ["hold", "Hold"],
                  ["fill", "Fill / repair"],
                  ["crossfade", "Crossfade"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={
                    params.strategy === id
                      ? "join-studio-chip is-active"
                      : "join-studio-chip"
                  }
                  disabled={locked}
                  onClick={() => updateParams({ strategy: id as JoinStrategy })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="join-studio-params">
            <Stepper
              label="Nudge A out"
              value={params.nudgeAOutFrames}
              disabled={locked}
              onChange={(nudgeAOutFrames) => updateParams({ nudgeAOutFrames })}
            />
            <Stepper
              label="Nudge B in"
              value={params.nudgeBInFrames}
              disabled={locked}
              onChange={(nudgeBInFrames) => updateParams({ nudgeBInFrames })}
            />
            {params.strategy === "hold" ? (
              <>
                <label className="join-studio-stepper">
                  <span>Hold side</span>
                  <select
                    value={params.holdSide}
                    disabled={locked}
                    onChange={(event) =>
                      updateParams({
                        holdSide: event.target.value as JoinHoldSide,
                      })
                    }
                  >
                    <option value="A">A last frame</option>
                    <option value="B">B first frame</option>
                  </select>
                </label>
                <Stepper
                  label="Hold frames"
                  value={params.holdFrames}
                  min={1}
                  max={60}
                  disabled={locked}
                  onChange={(holdFrames) => updateParams({ holdFrames })}
                />
              </>
            ) : null}
            {params.strategy === "fill" ? (
              <>
                <label className="join-studio-stepper">
                  <span>Fill from</span>
                  <select
                    value={params.fillFrom}
                    disabled={locked}
                    onChange={(event) =>
                      updateParams({
                        fillFrom: event.target.value as JoinFillFrom,
                      })
                    }
                  >
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="both">Both</option>
                  </select>
                </label>
                <Stepper
                  label="Fill frames"
                  value={params.fillFrames}
                  min={1}
                  max={60}
                  disabled={locked}
                  onChange={(fillFrames) => updateParams({ fillFrames })}
                />
              </>
            ) : null}
            {params.strategy === "crossfade" ? (
              <Stepper
                label="Xfade frames"
                value={params.xfadeFrames}
                min={1}
                max={30}
                disabled={locked}
                onChange={(xfadeFrames) => updateParams({ xfadeFrames })}
              />
            ) : null}
          </div>

          <div className="join-studio-actions-row">
            <button
              type="button"
              className="btn primary"
              disabled={locked || previewBusy}
              onClick={() => void runPreview(params)}
            >
              Re-render
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={locked || previewBusy}
              onClick={onReset}
            >
              Reset
            </button>
            <span className="join-studio-span-hint">
              Commit span ≈ {span.durationSec.toFixed(2)}s
            </span>
          </div>
        </div>

        {commitError ? (
          <div className="join-studio-commit-error" role="alert">
            {commitError}
            <button type="button" onClick={() => setCommitError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {committing ? (
          <div className="join-studio-committing">
            <span className="confirm-dialog-spinner" aria-hidden />
            {commitLabel}
          </div>
        ) : null}

        <footer className="join-studio-footer">
          <button type="button" className="btn ghost" disabled={locked} onClick={onDone}>
            Done
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={locked || !previewFresh || previewBusy}
            title={
              previewFresh
                ? "Bake join into a new library clip and replace both clips"
                : "Re-render a fresh Final preview before committing"
            }
            onClick={() => void onCommit()}
          >
            Commit join
          </button>
        </footer>
      </div>
    </div>
  );
}
