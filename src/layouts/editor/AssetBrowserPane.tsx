import { listen } from "@tauri-apps/api/event";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { AudioWaveform } from "../../library/AudioWaveform";
import { ensureLocal, getCreation } from "../../library/catalogClient";
import { creationCardTitle } from "../../library/creationFlags";
import {
  canFetchLocal,
  creationPreviewUrl,
  isParasceneUnavailable,
} from "../../library/previewUrl";
import type { Creation, MediaType } from "../../library/types";
import { isPreviewDecoded, whenPreviewReady } from "../../library/warmPreviews";
import type { ProjectAsset } from "../../project/types";

export type AssetKindFilter = "all" | MediaType;

const FILTERS: { id: AssetKindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Video" },
  { id: "image", label: "Image" },
  { id: "audio", label: "Audio" },
];

type AssetBrowserPaneProps = {
  assets: ProjectAsset[];
  filter: AssetKindFilter;
  selectedId: string | null;
  onFilterChange: (filter: AssetKindFilter) => void;
  onSelect: (id: string) => void;
  onCollapse: () => void;
  /** True when shown as a narrow-desktop drawer overlay. */
  drawer?: boolean;
};

function kindFromCreation(
  creation: Creation | undefined,
  fallback: ProjectAsset["kind"],
): ProjectAsset["kind"] {
  const mt = String(creation?.mediaType ?? fallback)
    .trim()
    .toLowerCase();
  if (mt === "video" || mt === "audio" || mt === "image") return mt;
  return fallback;
}

function displayName(
  asset: ProjectAsset,
  creation: Creation | undefined,
): string {
  if (creation) {
    const titled = creationCardTitle(creation);
    if (!titled.untitled) return titled.text;
    const filename = creation.filename?.trim();
    if (filename) return filename;
  }
  return asset.name;
}

function AssetThumb({
  kind,
  creation,
}: {
  kind: ProjectAsset["kind"];
  creation: Creation | undefined;
}) {
  const preview = creation ? creationPreviewUrl(creation) : null;
  const unavailable = creation ? isParasceneUnavailable(creation) : false;
  const waitingOnDisk = Boolean(creation) && !preview && !unavailable;
  const [paintSrc, setPaintSrc] = useState<string | null>(() =>
    preview && isPreviewDecoded(preview) ? preview : null,
  );

  useLayoutEffect(() => {
    if (!preview) {
      setPaintSrc(null);
      return;
    }
    if (isPreviewDecoded(preview)) {
      setPaintSrc(preview);
      return;
    }
    let cancelled = false;
    void whenPreviewReady(preview).then(() => {
      if (!cancelled) setPaintSrc(preview);
    });
    return () => {
      cancelled = true;
    };
  }, [preview]);

  useEffect(() => {
    if (!creation || unavailable || !canFetchLocal(creation) || preview) {
      return;
    }
    void ensureLocal([creation.id], { fullMedia: false });
  }, [creation, unavailable, preview]);

  const showImage = Boolean(paintSrc && paintSrc === preview);
  // Decorative icon — always for audio kind (no need for local media first).
  const showAudio = kind === "audio" && !showImage;
  const showPending =
    !showAudio && (waitingOnDisk || (Boolean(preview) && !showImage));
  const label = kind === "video" ? "Video" : kind === "audio" ? "Audio" : "Image";

  return (
    <div
      className={[
        "editor-asset-thumb",
        `kind-${kind}`,
        showPending ? "is-pending" : "",
        unavailable && !showAudio ? "is-broken" : "",
        showImage ? "has-image" : "",
        showAudio ? "is-audio" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden
    >
      {showImage ? (
        <img src={paintSrc!} alt="" loading="eager" decoding="async" draggable={false} />
      ) : showAudio ? (
        <span className="editor-asset-audio-icon">
          <AudioWaveform className="editor-asset-audio-wave" />
        </span>
      ) : showPending ? (
        <span className="editor-asset-thumb-shimmer" />
      ) : (
        <span className="editor-asset-thumb-label">{label}</span>
      )}
      {kind === "video" && showImage ? (
        <span className="editor-asset-play-badge" />
      ) : null}
    </div>
  );
}

export function AssetBrowserPane({
  assets,
  filter,
  selectedId,
  onFilterChange,
  onSelect,
  onCollapse,
  drawer = false,
}: AssetBrowserPaneProps) {
  const [creationsById, setCreationsById] = useState<
    Record<string, Creation>
  >({});

  const assetIdsKey = useMemo(
    () => assets.map((a) => a.id).join("\0"),
    [assets],
  );

  useEffect(() => {
    const ids = assetIdsKey ? assetIdsKey.split("\0") : [];
    if (ids.length === 0) {
      setCreationsById({});
      return;
    }

    let cancelled = false;

    const load = async () => {
      const next: Record<string, Creation> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            next[id] = await getCreation(id);
          } catch {
            // Not in local catalog (fixture ids / stale references).
          }
        }),
      );
      if (cancelled) return;
      setCreationsById(next);

      const needThumbs = Object.values(next)
        .filter((c) => !creationPreviewUrl(c) && canFetchLocal(c))
        .map((c) => c.id);
      if (needThumbs.length > 0) {
        void ensureLocal(needThumbs, { fullMedia: false });
      }
    };

    void load();

    let unlisten: (() => void) | undefined;
    void listen<Creation>("library-creation-updated", (event) => {
      const row = event.payload;
      if (!ids.includes(row.id)) return;
      setCreationsById((prev) => ({ ...prev, [row.id]: row }));
    }).then((off) => {
      unlisten = off;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [assetIdsKey]);

  const visible = assets.filter((asset) => {
    if (filter === "all") return true;
    return kindFromCreation(creationsById[asset.id], asset.kind) === filter;
  });

  return (
    <aside
      className={drawer ? "editor-asset-pane is-drawer" : "editor-asset-pane"}
      aria-label="Assets"
    >
      <div className="editor-pane-head">
        <h2>Assets</h2>
        <button type="button" className="btn ghost" onClick={onCollapse}>
          Collapse
        </button>
      </div>

      <div className="editor-asset-filters" role="toolbar" aria-label="Asset filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={
              filter === f.id
                ? "editor-asset-filter is-active"
                : "editor-asset-filter"
            }
            aria-pressed={filter === f.id}
            onClick={() => onFilterChange(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="editor-asset-scroll">
        {visible.length === 0 ? (
          <p className="muted editor-asset-empty">No assets in this filter.</p>
        ) : (
          <ul className="editor-asset-grid">
            {visible.map((asset) => {
              const creation = creationsById[asset.id];
              const kind = kindFromCreation(creation, asset.kind);
              const name = displayName(asset, creation);
              return (
                <li key={asset.id}>
                  <button
                    type="button"
                    className={
                      selectedId === asset.id
                        ? "editor-asset-tile is-selected"
                        : "editor-asset-tile"
                    }
                    onClick={() => onSelect(asset.id)}
                    title={name}
                  >
                    <AssetThumb kind={kind} creation={creation} />
                    <span className="editor-asset-meta">
                      <span className="editor-asset-kind">{kind}</span>
                      <span className="editor-asset-name">{name}</span>
                      {(kind === "video" || kind === "audio") && (
                        <span className="editor-asset-duration muted">
                          {asset.durationLabel ?? "—"}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
