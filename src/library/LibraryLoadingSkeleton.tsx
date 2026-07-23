import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  boardColumnLayoutForFilter,
  folderBoardAspect,
  togglesFromFilterId,
  type FilterId,
} from "./creationFilters";
import {
  MASONRY_GAP_PX,
  masonryBoardMetrics,
} from "./CreationsMasonry";

const SIDEBAR_FILTER_ROWS = 8;
const SIDEBAR_ASPECT_ROWS = 4;
const SIDEBAR_SELECTION_ROWS = 2;
const SKELETON_TILE_FALLBACK = 108;
/** Pad ~50% past the measured viewport so the board feels full while loading. */
const SKELETON_TILE_BUFFER = 1.5;

export type SkeletonTileLayout = {
  top: number;
  left: number;
  width: number;
  height: number;
};

/** Enough tiles to cover the visible grid plus generous overscroll. */
export function skeletonTileCount(
  width: number,
  height: number,
  packHeight: number,
  filterId: FilterId = "all",
): number {
  if (width <= 0 || height <= 0) return SKELETON_TILE_FALLBACK;
  const columnLayout = boardColumnLayoutForFilter(filterId) ?? undefined;
  const { columnWidth } = masonryBoardMetrics(width, columnLayout);
  const tileHeight = Math.max(48, columnWidth * packHeight);
  const rowStride = tileHeight + MASONRY_GAP_PX;
  const { columnCount } = masonryBoardMetrics(width, columnLayout);
  const rows = Math.max(
    3,
    Math.ceil((height / rowStride) * SKELETON_TILE_BUFFER) + 1,
  );
  return columnCount * rows;
}

/** Pack skeleton tiles with the same column math as VirtualCreationsGrid. */
export function layoutSkeletonBoard(
  tileCount: number,
  width: number,
  packHeight: number,
  filterId: FilterId = "all",
): { tiles: SkeletonTileLayout[]; totalHeight: number } {
  const columnLayout = boardColumnLayoutForFilter(filterId) ?? undefined;
  const { columnCount, columnWidth } = masonryBoardMetrics(width, columnLayout);
  const cols = Math.max(1, columnCount);
  const tops = Array.from({ length: cols }, () => 0);
  const tiles: SkeletonTileLayout[] = [];
  const tileHeight = Math.max(48, columnWidth * packHeight);

  for (let index = 0; index < tileCount; index++) {
    let col = 0;
    for (let c = 1; c < cols; c++) {
      if (tops[c] < tops[col]) col = c;
    }
    tiles.push({
      top: tops[col],
      left: col * (columnWidth + MASONRY_GAP_PX),
      width: columnWidth,
      height: tileHeight,
    });
    tops[col] += tileHeight + MASONRY_GAP_PX;
  }

  return {
    tiles,
    totalHeight: Math.max(0, ...tops),
  };
}

function SkeletonRow({ wide = false }: { wide?: boolean }) {
  return (
    <div className="library-skeleton-filter-row" aria-hidden>
      <span className="library-skeleton-chip" />
      <span
        className={`library-skeleton-line${wide ? " is-wide" : ""}`}
      />
      <span className="library-skeleton-chip is-count" />
    </div>
  );
}

function CreationsSidebarSkeleton({ width }: { width: number }) {
  return (
    <aside
      className="creations-sidebar library-skeleton-sidebar"
      style={{ width }}
      aria-label="Loading filters"
      aria-busy
    >
      <div className="library-skeleton-import" aria-hidden />
      {Array.from({ length: SIDEBAR_FILTER_ROWS }, (_, index) => (
        <SkeletonRow key={`media-${index}`} />
      ))}
      <p className="creations-sidebar-title creations-sidebar-section library-skeleton-section-label">
        Aspect
      </p>
      {Array.from({ length: SIDEBAR_ASPECT_ROWS }, (_, index) => (
        <SkeletonRow key={`aspect-${index}`} wide />
      ))}
      <p className="creations-sidebar-title creations-sidebar-section library-skeleton-section-label">
        Selection
      </p>
      {Array.from({ length: SIDEBAR_SELECTION_ROWS }, (_, index) => (
        <SkeletonRow key={`selection-${index}`} />
      ))}
    </aside>
  );
}

function CreationsGridSkeleton({ filterId }: { filterId: FilterId }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { packHeight } = folderBoardAspect(togglesFromFilterId(filterId));
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tileCount = useMemo(
    () => skeletonTileCount(size.width, size.height, packHeight, filterId),
    [filterId, packHeight, size.height, size.width],
  );

  const board = useMemo(
    () => layoutSkeletonBoard(tileCount, size.width, packHeight, filterId),
    [filterId, packHeight, size.width, tileCount],
  );

  return (
    <div
      ref={scrollerRef}
      className="creations-virtual-scroller library-skeleton-scroller"
      aria-label="Loading creations"
      aria-busy
    >
      <div
        className="creations-virtual-space"
        style={{ height: board.totalHeight || undefined }}
      >
        {board.tiles.map((tile, index) => {
          const style = {
            top: tile.top,
            left: tile.left,
            width: tile.width,
            height: tile.height,
          } satisfies CSSProperties;
          return (
            <div
              key={index}
              className="creations-virtual-item library-skeleton-item"
              style={style}
            >
              <div className="library-skeleton-tile" aria-hidden />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Full library board shell while the catalog has not loaded yet. */
export function LibraryPageSkeleton({
  sidebarWidth,
  filterId = "all",
}: {
  sidebarWidth: number;
  filterId?: FilterId;
}) {
  return (
    <div className="creations-split library-page-skeleton" aria-busy>
      <CreationsSidebarSkeleton width={sidebarWidth} />
      <div
        className="creations-split-resizer library-skeleton-resizer"
        aria-hidden
      />
      <div className="creations-split-main">
        <CreationsGridSkeleton filterId={filterId} />
      </div>
    </div>
  );
}
