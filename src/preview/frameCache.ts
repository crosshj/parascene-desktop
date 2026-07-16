/**
 * Bounded VideoFrame cache keyed by assetId + frame timestamp (µs).
 * Always closes frames on eviction.
 */

export type CachedFrame = {
  assetId: string;
  timestampUs: number;
  frame: VideoFrame;
  lastAccess: number;
};

export class FrameCache {
  private readonly maxFrames: number;
  private readonly entries = new Map<string, CachedFrame>();
  private accessCounter = 0;

  constructor(maxFrames = 48) {
    this.maxFrames = Math.max(1, maxFrames);
  }

  static key(assetId: string, timestampUs: number): string {
    return `${assetId}:${timestampUs}`;
  }

  get size(): number {
    return this.entries.size;
  }

  get(assetId: string, timestampUs: number): VideoFrame | null {
    const entry = this.entries.get(FrameCache.key(assetId, timestampUs));
    if (!entry) return null;
    entry.lastAccess = ++this.accessCounter;
    return entry.frame;
  }

  /** Closest cached frame within `toleranceUs` of the target (same asset). */
  findNearest(
    assetId: string,
    targetUs: number,
    toleranceUs: number,
  ): CachedFrame | null {
    let best: CachedFrame | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (entry.assetId !== assetId) continue;
      const dist = Math.abs(entry.timestampUs - targetUs);
      if (dist <= toleranceUs && dist < bestDist) {
        best = entry;
        bestDist = dist;
      }
    }
    if (best) best.lastAccess = ++this.accessCounter;
    return best;
  }

  set(assetId: string, timestampUs: number, frame: VideoFrame): void {
    const key = FrameCache.key(assetId, timestampUs);
    const prev = this.entries.get(key);
    if (prev) {
      if (prev.frame !== frame) prev.frame.close();
      this.entries.delete(key);
    }
    this.entries.set(key, {
      assetId,
      timestampUs,
      frame,
      lastAccess: ++this.accessCounter,
    });
    this.evictIfNeeded();
  }

  /** Keep only frames for `assetId` whose timestamp is in [startUs, endUs]. */
  retainRange(assetId: string, startUs: number, endUs: number): void {
    const lo = Math.min(startUs, endUs);
    const hi = Math.max(startUs, endUs);
    for (const [key, entry] of this.entries) {
      if (entry.assetId !== assetId) continue;
      if (entry.timestampUs < lo || entry.timestampUs > hi) {
        entry.frame.close();
        this.entries.delete(key);
      }
    }
  }

  releaseAsset(assetId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.assetId !== assetId) continue;
      entry.frame.close();
      this.entries.delete(key);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.frame.close();
    }
    this.entries.clear();
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxFrames) {
      let oldestKey: string | null = null;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastAccess < oldestAccess) {
          oldestAccess = entry.lastAccess;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      const doomed = this.entries.get(oldestKey);
      if (doomed) doomed.frame.close();
      this.entries.delete(oldestKey);
    }
  }
}
