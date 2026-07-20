import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getEnvConfig } from "../auth/session";
import {
  mapGroupSourceCreations,
} from "../sync/manifestSync";
import { creationPageUrl } from "../sync/syncState";
import { useConfirm } from "../ui/ConfirmDialog";
import { creationAspectCss } from "./aspectRatio";
import { AudioWaveform } from "./AudioWaveform";
import {
  applyManifest,
  deleteLocal,
  ensureLocal,
  fillThumb,
  fillThumbAndPushToCloud,
  getCreation,
  getCreations,
} from "./catalogClient";
import {
  groupEmbeddedSourceCreations,
  groupSourceCreationIds,
  isGroupCreation,
} from "./creationFlags";
import { isLocalOnlyCreation } from "./creationFilters";
import {
  canFetchLocal,
  creationDetailUrl,
  creationPreviewUrl,
  isParasceneUnavailable,
} from "./previewUrl";
import type { Creation } from "./types";

function formatInvokeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function CreationLightbox({
  creation,
  onClose,
  onDeleted,
}: {
  creation: Creation;
  onClose: () => void;
  /** Called after a successful local catalog delete (files + DB row). */
  onDeleted?: (id: string) => void;
}) {
  const confirm = useConfirm();
  const groupIds = useMemo(
    () => (isGroupCreation(creation) ? groupSourceCreationIds(creation) : []),
    [creation],
  );
  const [loadedGroup, setLoadedGroup] = useState<{
    ownerId: string;
    members: Creation[];
  } | null>(null);
  const groupMembers =
    loadedGroup?.ownerId === creation.id ? loadedGroup.members : [];
  const [groupIndex, setGroupIndex] = useState(0);
  const isGroupCarousel = groupMembers.length > 1;
  const [liveCreation, setLiveCreation] = useState(creation);
  useEffect(() => {
    // Intentional: mirror the latest `creation` prop into local state so live
    // catalog updates re-render the lightbox.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLiveCreation(creation);
  }, [creation]);
  const displayedCreation = groupMembers[groupIndex] ?? liveCreation;
  const detail = creationDetailUrl(displayedCreation);
  const thumb = creationPreviewUrl(displayedCreation);
  const aspectCss = creationAspectCss(displayedCreation);
  const unavailable = isParasceneUnavailable(displayedCreation);
  const canOpenOnWeb = canFetchLocal(creation);
  const waiting =
    !detail && canFetchLocal(displayedCreation) && !unavailable;
  const mediaType = String(displayedCreation.mediaType ?? "")
    .trim()
    .toLowerCase();
  const isVideo = mediaType === "video";
  const isAudio = mediaType === "audio";
  const webUrl = creationPageUrl(getEnvConfig().baseUrl, creation.id);
  const [busyKind, setBusyKind] = useState<"fill" | "delete" | null>(null);
  const busy = busyKind !== null;
  const [actionError, setActionError] = useState<string | null>(null);

  const stepGroup = useCallback((direction: -1 | 1) => {
    setGroupIndex((current) => {
      if (groupMembers.length <= 1) return current;
      return (
        (current + direction + groupMembers.length) % groupMembers.length
      );
    });
  }, [groupMembers.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowLeft" && isGroupCarousel) {
        e.preventDefault();
        stepGroup(-1);
        return;
      }
      if (e.key === "ArrowRight" && isGroupCarousel) {
        e.preventDefault();
        stepGroup(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isGroupCarousel, onClose, stepGroup]);

  useEffect(() => {
    if (groupIds.length === 0) return;
    let cancelled = false;
    const load = async () => {
      let rows = await getCreations(groupIds);
      if (cancelled) return;
      const found = new Set(rows.map((row) => row.id));
      const missing = new Set(groupIds.filter((id) => !found.has(id)));
      if (missing.size > 0) {
        const upserts = mapGroupSourceCreations(
          groupEmbeddedSourceCreations(creation),
        ).filter((row) => missing.has(row.id));
        if (upserts.length > 0) {
          await applyManifest(upserts);
          if (cancelled) return;
          rows = await getCreations(groupIds);
        }
      }
      if (cancelled) return;
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ordered = groupIds
        .map((id) => byId.get(id))
        .filter((row): row is Creation => Boolean(row));
      setLoadedGroup({ ownerId: creation.id, members: ordered });
      setGroupIndex(0);
      void ensureLocal(
        ordered
          .filter(
            (row) =>
              !creationDetailUrl(row) &&
              canFetchLocal(row) &&
              !isParasceneUnavailable(row),
          )
          .map((row) => row.id),
        { fullMedia: true, urgent: true },
      );
    };
    void load().catch(() => {
      if (!cancelled) {
        setLoadedGroup({ ownerId: creation.id, members: [] });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [creation, groupIds]);

  useEffect(() => {
    const memberIds = new Set(groupIds);
    let unlisten: (() => void) | undefined;
    void listen<Creation>("library-creation-updated", (event) => {
      if (event.payload.id === creation.id) {
        setLiveCreation(event.payload);
      }
      if (!memberIds.has(event.payload.id)) return;
      setLoadedGroup((current) => {
        if (!current || current.ownerId !== creation.id) return current;
        return {
          ...current,
          members: current.members.map((row) =>
            row.id === event.payload.id ? event.payload : row,
          ),
        };
      });
    }).then((off) => {
      unlisten = off;
    });
    return () => unlisten?.();
  }, [creation.id, groupIds]);

  // Utmost priority: jump the download queue the moment the lightbox opens.
  useEffect(() => {
    if (detail || unavailable || !canFetchLocal(displayedCreation)) return;
    void ensureLocal([displayedCreation.id], {
      fullMedia: true,
      urgent: true,
    });
  }, [detail, displayedCreation, unavailable]);

  async function onFillThumb() {
    if (busy) return;
    const ok = await confirm({
      title: "Re-gen thumbnail?",
      message: isLocalOnlyCreation(liveCreation)
        ? "Rebuilds the board preview from full local media (embedded cover art for audio) and updates the aspect ratio to the closest standard."
        : "Rebuilds the board preview from full local media at its natural aspect, then uploads that fit thumbnail to Parascene (square web thumbs stay unchanged).",
      confirmLabel: "Re-gen thumb",
    });
    if (!ok) return;

    setBusyKind("fill");
    setActionError(null);
    try {
      let row = liveCreation;
      if (!row.localPath) {
        await ensureLocal([row.id], { fullMedia: true, urgent: true });
        for (let i = 0; i < 40; i += 1) {
          await new Promise((r) => window.setTimeout(r, 250));
          row = await getCreation(row.id);
          if (row.localPath) break;
        }
      }
      if (!row.localPath) {
        throw new Error(
          "Local media is not ready yet. Wait for the download, then try again.",
        );
      }
      const updated = isLocalOnlyCreation(row)
        ? await fillThumb(row.id)
        : await fillThumbAndPushToCloud(row.id);
      setLiveCreation(updated);
    } catch (e: unknown) {
      setActionError(formatInvokeError(e));
    } finally {
      setBusyKind(null);
    }
  }

  async function onDeleteLocal() {
    if (busy) return;
    const ok = await confirm({
      title: "Delete locally?",
      message:
        "Removes this creation from the local catalog and deletes any local media/preview files. Does not delete it from Parascene.",
      confirmLabel: "Delete locally",
      danger: true,
    });
    if (!ok) return;

    setBusyKind("delete");
    setActionError(null);
    try {
      await deleteLocal(creation.id);
      onDeleted?.(creation.id);
      onClose();
    } catch (e: unknown) {
      setActionError(formatInvokeError(e));
    } finally {
      setBusyKind(null);
    }
  }

  return (
    <div
      className="creation-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={displayedCreation.title}
      onClick={onClose}
    >
      <div
        className="creation-lightbox-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="creation-lightbox-actions">
          {canOpenOnWeb ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                void openUrl(webUrl);
              }}
            >
              View on Parascene
            </button>
          ) : null}
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => {
              void onFillThumb();
            }}
          >
            {busyKind === "fill" ? "Re-genning…" : "Re-gen thumb"}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => {
              void onDeleteLocal();
            }}
          >
            {busyKind === "delete" ? "Deleting…" : "Delete locally"}
          </button>
          <button
            type="button"
            className="btn creation-lightbox-close"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>
        {actionError ? <p className="library-error">{actionError}</p> : null}
        <div
          className={[
            "creation-lightbox-stage",
            isAudio ? "is-audio" : "",
            isAudio && thumb ? "has-cover" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={isAudio && !thumb ? undefined : { aspectRatio: aspectCss }}
        >
          {detail ? (
            isVideo ? (
              <video
                className="creation-lightbox-media"
                src={detail}
                controls
                autoPlay
                loop
                muted
              />
            ) : isAudio ? (
              <div className="creation-lightbox-audio">
                {thumb ? (
                  <img
                    className="creation-lightbox-media creation-lightbox-audio-cover"
                    src={thumb}
                    alt=""
                  />
                ) : (
                  <AudioWaveform className="creation-audio-wave creation-audio-wave-lg" />
                )}
                <audio
                  className="creation-lightbox-audio-el"
                  src={detail}
                  controls
                  autoPlay
                  preload="auto"
                />
              </div>
            ) : (
              <img
                className="creation-lightbox-media"
                src={detail}
                alt={displayedCreation.title}
              />
            )
          ) : (
            <>
              {thumb ? (
                <img
                  className="creation-lightbox-placeholder-thumb"
                  src={thumb}
                  alt=""
                />
              ) : (
                <div className="creation-lightbox-placeholder" aria-hidden />
              )}
              {waiting ? (
                <>
                  <span className="creation-lightbox-shimmer" aria-hidden />
                  <p className="creation-lightbox-wait muted">
                    Saving locally…
                  </p>
                </>
              ) : (
                <p className="creation-lightbox-wait muted">
                  No local media available.
                </p>
              )}
            </>
          )}
          {isGroupCarousel ? (
            <>
              <button
                type="button"
                className="creation-lightbox-group-nav creation-lightbox-group-nav-prev"
                aria-label="Previous grouped image"
                onClick={() => stepGroup(-1)}
              >
                <svg viewBox="0 0 24 24" aria-hidden focusable="false">
                  <path d="M14.5 6.5L9 12l5.5 5.5" />
                </svg>
              </button>
              <button
                type="button"
                className="creation-lightbox-group-nav creation-lightbox-group-nav-next"
                aria-label="Next grouped image"
                onClick={() => stepGroup(1)}
              >
                <svg viewBox="0 0 24 24" aria-hidden focusable="false">
                  <path d="M9.5 6.5L15 12l-5.5 5.5" />
                </svg>
              </button>
            </>
          ) : null}
        </div>
        <div className="creation-lightbox-meta">
          <h2>{displayedCreation.title}</h2>
          <p className="muted">
            {displayedCreation.mediaType}
            {" · "}
            {displayedCreation.downloadState}
            {displayedCreation.published ? " · published" : ""}
            {isGroupCarousel
              ? ` · ${groupIndex + 1} of ${groupMembers.length}`
              : ""}
          </p>
          {displayedCreation.prompt ? (
            <p className="creation-lightbox-prompt">
              {displayedCreation.prompt}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
