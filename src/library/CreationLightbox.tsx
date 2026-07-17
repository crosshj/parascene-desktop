import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { getEnvConfig } from "../auth/session";
import { creationPageUrl } from "../sync/syncState";
import { useConfirm } from "../ui/ConfirmDialog";
import { creationAspectCss } from "./aspectRatio";
import { AudioWaveform } from "./AudioWaveform";
import {
  deleteLocal,
  ensureLocal,
  fillThumbAndPushToCloud,
  getCreation,
} from "./catalogClient";
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
  const detail = creationDetailUrl(creation);
  const thumb = creationPreviewUrl(creation);
  const aspectCss = creationAspectCss(creation);
  const unavailable = isParasceneUnavailable(creation);
  const canOpenOnWeb = canFetchLocal(creation);
  const waiting = !detail && canOpenOnWeb && !unavailable;
  const mediaType = String(creation.mediaType ?? "").trim().toLowerCase();
  const isVideo = mediaType === "video";
  const isAudio = mediaType === "audio";
  const webUrl = creationPageUrl(getEnvConfig().baseUrl, creation.id);
  const [busyKind, setBusyKind] = useState<"fill" | "delete" | null>(null);
  const busy = busyKind !== null;
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Utmost priority: jump the download queue the moment the lightbox opens.
  useEffect(() => {
    if (detail || unavailable || !canFetchLocal(creation)) return;
    void ensureLocal([creation.id], { fullMedia: true, urgent: true });
  }, [creation.id, detail, unavailable, creation]);

  async function onFillThumb() {
    if (busy) return;
    const ok = await confirm({
      title: "Fill thumbnail?",
      message:
        "Rebuilds the board preview from full local media at its natural aspect, then uploads that fit thumbnail to Parascene (square web thumbs stay unchanged).",
      confirmLabel: "Fill thumbnail",
    });
    if (!ok) return;

    setBusyKind("fill");
    setActionError(null);
    try {
      let row = creation;
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
      await fillThumbAndPushToCloud(row.id);
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
      aria-label={creation.title}
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
          {!isAudio ? (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                void onFillThumb();
              }}
            >
              {busyKind === "fill" ? "Filling…" : "Fill thumbnail"}
            </button>
          ) : null}
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
          ]
            .filter(Boolean)
            .join(" ")}
          style={isAudio ? undefined : { aspectRatio: aspectCss }}
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
                <AudioWaveform className="creation-audio-wave creation-audio-wave-lg" />
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
                alt={creation.title}
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
        </div>
        <div className="creation-lightbox-meta">
          <h2>{creation.title}</h2>
          <p className="muted">
            {creation.mediaType}
            {" · "}
            {creation.downloadState}
            {creation.published ? " · published" : ""}
          </p>
          {creation.prompt ? (
            <p className="creation-lightbox-prompt">{creation.prompt}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
