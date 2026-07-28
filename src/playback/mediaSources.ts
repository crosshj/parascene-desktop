import { listen } from "@tauri-apps/api/event";
import { ensureLocal, getCreation } from "../library/catalogClient";
import {
  canFetchLocal,
  creationDetailUrl,
  creationPreviewUrl,
  isParasceneUnavailable,
} from "../library/previewUrl";
import {
  ensureReversedMedia,
  getCachedReversedMedia,
  subscribeReversedMediaCache,
} from "../library/reversedMedia";
import type { Creation } from "../library/types";

export type AssetMediaSnapshot = {
  detail: string | null;
  thumb: string | null;
  waitingLocal: boolean;
};

export type ReverseMediaSnapshot = {
  detail: string | null;
  busy: boolean;
  needsBake: boolean;
  error: string | null;
};

/**
 * Imperative catalog + reverse-bake URL cache for the playback engine.
 * Replaces `useAssetMedia` / `useReversedDetail` without React.
 */
export type MediaSources = {
  ensureAsset(assetId: string): void;
  ensureReverse(assetId: string): void;
  getAsset(assetId: string): AssetMediaSnapshot;
  getReverse(assetId: string): ReverseMediaSnapshot;
  /** Kick catalog/local fetch for every timeline asset id (forward + audio). */
  prewarmAssets(assetIds: Iterable<string>): void;
  /** Prewarm reverse bakes for every reverse video clip asset id. */
  prewarmReverse(assetIds: Iterable<string>): void;
  subscribe(listener: () => void): () => void;
  destroy(): void;
};

export function createMediaSources(): MediaSources {
  const creations = new Map<string, Creation | null>();
  const detailFailed = new Set<string>();
  const reverseFailed = new Set<string>();
  const listeners = new Set<() => void>();
  const inflightAsset = new Set<string>();
  let unlistenCreation: (() => void) | undefined;
  let destroyed = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  void listen<Creation>("library-creation-updated", (event) => {
    if (destroyed) return;
    const row = event.payload;
    creations.set(row.id, row);
    detailFailed.delete(row.id);
    notify();
  }).then((off) => {
    if (destroyed) {
      off();
      return;
    }
    unlistenCreation = off;
  });

  const unsubReverse = subscribeReversedMediaCache(() => {
    if (destroyed) return;
    notify();
  });

  const snapshotAsset = (assetId: string): AssetMediaSnapshot => {
    const creation = creations.get(assetId) ?? null;
    if (!creation) {
      return { detail: null, thumb: null, waitingLocal: false };
    }
    const detail = detailFailed.has(assetId)
      ? null
      : creationDetailUrl(creation);
    const thumb = creationPreviewUrl(creation);
    const unavailable = isParasceneUnavailable(creation);
    const waitingLocal =
      !detail &&
      !thumb &&
      canFetchLocal(creation) &&
      !unavailable;
    return { detail, thumb, waitingLocal };
  };

  const snapshotReverse = (assetId: string): ReverseMediaSnapshot => {
    if (!assetId.trim()) {
      return { detail: null, busy: false, needsBake: false, error: null };
    }
    const cached = getCachedReversedMedia(assetId);
    if (cached) {
      return {
        detail: cached.mediaUrl,
        busy: false,
        needsBake: false,
        error: null,
      };
    }
    if (reverseFailed.has(assetId)) {
      return {
        detail: null,
        busy: false,
        needsBake: true,
        error: "Reversed media unavailable",
      };
    }
    return { detail: null, busy: true, needsBake: false, error: null };
  };

  const ensureAsset = (assetId: string) => {
    if (destroyed) return;
    const id = assetId.trim();
    if (!id || inflightAsset.has(id) || creations.has(id)) return;
    inflightAsset.add(id);
    void getCreation(id)
      .then((row) => {
        if (destroyed) return;
        creations.set(id, row);
        if (
          !creationDetailUrl(row) &&
          canFetchLocal(row) &&
          !isParasceneUnavailable(row)
        ) {
          void ensureLocal([row.id], { fullMedia: true, urgent: true });
        }
        notify();
      })
      .catch(() => {
        if (destroyed) return;
        creations.set(id, null);
        notify();
      })
      .finally(() => {
        inflightAsset.delete(id);
      });
  };

  const ensureReverse = (assetId: string) => {
    if (destroyed) return;
    const id = assetId.trim();
    if (!id) return;
    if (getCachedReversedMedia(id)) return;
    void ensureReversedMedia(id).catch(() => {
      if (destroyed) return;
      reverseFailed.add(id);
      notify();
    });
  };

  return {
    ensureAsset,
    ensureReverse,
    getAsset(assetId) {
      return snapshotAsset(assetId.trim());
    },
    getReverse(assetId) {
      return snapshotReverse(assetId.trim());
    },
    prewarmAssets(assetIds) {
      if (destroyed) return;
      for (const raw of assetIds) {
        const id = raw.trim();
        if (!id) continue;
        ensureAsset(id);
      }
    },
    prewarmReverse(assetIds) {
      if (destroyed) return;
      for (const raw of assetIds) {
        const id = raw.trim();
        if (!id) continue;
        if (getCachedReversedMedia(id)) continue;
        void ensureReversedMedia(id).catch(() => {});
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      unlistenCreation?.();
      unsubReverse();
      creations.clear();
      detailFailed.clear();
      reverseFailed.clear();
      inflightAsset.clear();
    },
  };
}
