import { describe, expect, it } from "vitest";
import {
  layoutSkeletonBoard,
  skeletonTileCount,
} from "./LibraryLoadingSkeleton";

describe("skeletonTileCount", () => {
  it("fills a wide board with multiple rows of squares", () => {
    const count = skeletonTileCount(1200, 900, 1);
    expect(count).toBeGreaterThan(24);
    expect(count % 5).toBe(0);
  });

  it("uses more tiles for taller viewports", () => {
    const short = skeletonTileCount(1000, 500, 1);
    const tall = skeletonTileCount(1000, 1100, 1);
    expect(tall).toBeGreaterThan(short);
  });

  it("returns a generous fallback when size is unknown", () => {
    expect(skeletonTileCount(0, 0, 1)).toBeGreaterThan(24);
  });
});

describe("layoutSkeletonBoard", () => {
  it("packs 1:1 tiles with equal width and height", () => {
    const { tiles } = layoutSkeletonBoard(12, 1000, 1);
    expect(tiles.length).toBe(12);
    for (const tile of tiles) {
      expect(tile.width).toBe(tile.height);
    }
  });
});
