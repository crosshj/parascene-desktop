/**
 * Fixed-row windowed list. Parent supplies totalCount + sparse getRow;
 * onVisibleRange asks the parent to page from the BE as needed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReplicateModelRow } from "../../replicate/replicateClient";

export const REPLICATE_ROW_HEIGHT = 88;
const OVERSCAN_PX = 800;

type Props = {
  totalCount: number;
  getRow: (index: number) => ReplicateModelRow | undefined;
  selectedKey: string | null;
  onSelect: (row: ReplicateModelRow) => void;
  /** Called when the visible (+ overscan) index range changes. */
  onVisibleRange: (start: number, end: number) => void;
  /** Change to reset scroll to top (e.g. sort/filter). */
  resetKey?: string;
};

export function ReplicateModelsVirtualList({
  totalCount,
  getRow,
  selectedKey,
  onSelect,
  onVisibleRange,
  resetKey,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);
  const lastRangeRef = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
  }, []);

  const range = useMemo(() => {
    if (totalCount <= 0) return { start: 0, end: 0 };
    const start = Math.max(
      0,
      Math.floor((scrollTop - OVERSCAN_PX) / REPLICATE_ROW_HEIGHT),
    );
    const end = Math.min(
      totalCount,
      Math.ceil((scrollTop + viewportH + OVERSCAN_PX) / REPLICATE_ROW_HEIGHT),
    );
    return { start, end };
  }, [scrollTop, totalCount, viewportH]);

  useEffect(() => {
    const prev = lastRangeRef.current;
    if (prev && prev.start === range.start && prev.end === range.end) return;
    lastRangeRef.current = range;
    onVisibleRange(range.start, range.end);
  }, [onVisibleRange, range]);

  const totalHeight = Math.max(0, totalCount) * REPLICATE_ROW_HEIGHT;
  const indices: number[] = [];
  for (let i = range.start; i < range.end; i++) indices.push(i);

  return (
    <div
      ref={scrollerRef}
      className="lab-replicate-virtual"
      role="list"
      onScroll={onScroll}
    >
      <div
        className="lab-replicate-virtual-space"
        style={{ height: totalHeight }}
        aria-hidden={totalCount === 0}
      >
        {indices.map((index) => {
          const r = getRow(index);
          if (!r) {
            return (
              <div
                key={`skeleton-${index}`}
                className="lab-replicate-row is-skeleton"
                style={{
                  position: "absolute",
                  top: index * REPLICATE_ROW_HEIGHT,
                  left: 0,
                  right: 0,
                  height: REPLICATE_ROW_HEIGHT,
                }}
                aria-hidden
              />
            );
          }
          const key = `${r.owner}/${r.name}`;
          const active = selectedKey === key;
          return (
            <button
              key={key}
              type="button"
              role="listitem"
              className={[
                "lab-replicate-row",
                active ? "is-active" : "",
                r.enabled ? "is-enabled" : "is-disabled-model",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                position: "absolute",
                top: index * REPLICATE_ROW_HEIGHT,
                left: 0,
                right: 0,
                height: REPLICATE_ROW_HEIGHT,
              }}
              onClick={() => onSelect(r)}
            >
              {r.coverImageUrl ? (
                <img
                  className="lab-replicate-thumb"
                  src={r.coverImageUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="lab-replicate-thumb is-empty" aria-hidden />
              )}
              <span className="lab-replicate-row-body">
                <span className="lab-replicate-row-title">
                  {r.owner}/{r.name}
                </span>
                <span className="muted lab-replicate-row-meta">
                  {r.enabled ? "Enabled" : "Not enabled"} · runs{" "}
                  {r.runCount.toLocaleString()}
                </span>
                {r.description ? (
                  <span className="muted lab-replicate-row-desc">
                    {r.description}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {totalCount === 0 ? (
        <p className="muted lab-replicate-empty">No models match.</p>
      ) : null}
    </div>
  );
}
