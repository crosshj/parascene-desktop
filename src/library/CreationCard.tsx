import { memo, useEffect } from "react";
import { ensureLocal } from "./catalogClient";
import {
  creationCardTitle,
  isGroupCreation,
  isPublishedCreation,
} from "./creationFlags";
import {
  canFetchLocal,
  creationPreviewUrl,
  isParasceneUnavailable,
} from "./previewUrl";
import type { Creation } from "./types";

function BrokenPreview() {
  return (
    <div className="creation-thumb creation-thumb-broken" aria-hidden>
      <svg
        className="creation-broken-icon"
        viewBox="0 0 24 24"
        width="28"
        height="28"
      >
        <rect
          x="3.5"
          y="3.5"
          width="17"
          height="17"
          rx="2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M5 19 L19 5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

function VideoPlayBadge() {
  return (
    <span className="creation-badge creation-play-badge" title="Video" aria-hidden>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="6 3 20 12 6 21 6 3" />
      </svg>
    </span>
  );
}

function PublishedBadge() {
  return (
    <span
      className="creation-badge creation-published-badge"
      title="Published"
      aria-hidden
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    </span>
  );
}

function GroupBadge() {
  return (
    <span
      className="creation-badge creation-group-badge"
      title="Group creation"
      aria-hidden
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3.5" y="6.5" width="9.5" height="9.5" rx="2" />
        <rect x="10.5" y="10.5" width="10" height="10" rx="2" />
      </svg>
    </span>
  );
}

/** Centered eye-with-slash — NSFW board preview (lightbox reveals clear media). */
function NsfwHiddenBadge() {
  return (
    <span className="creation-nsfw-badge" title="NSFW" aria-hidden>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M 1.166 11.968 C 8.351 3.687 15.535 3.687 22.721 11.968 C 15.535 20.252 8.351 20.252 1.166 11.968 Z" />
        <circle cx="12.027" cy="12.053" r="5.632" />
        <line x1="6.986" y1="7.246" x2="16.571" y2="16.832" />
      </svg>
    </span>
  );
}

/**
 * Board card: local thumbnail + catalog aspect slot. Share / group / play sit
 * top-left as matching badges. NSFW stays centered with blur; lightbox
 * reveals clear media.
 */
export const CreationCard = memo(function CreationCard({
  creation,
  aspectCss,
  onOpen,
}: {
  creation: Creation;
  aspectCss: string;
  onOpen: (creation: Creation) => void;
}) {
  const preview = creationPreviewUrl(creation);
  const unavailable = isParasceneUnavailable(creation);
  const waitingOnDisk = !preview && !unavailable;
  const isVideo = creation.mediaType === "video";
  const isNsfw = creation.nsfw === true;
  const published = isPublishedCreation(creation);
  const isGroup = isGroupCreation(creation);
  const showPlay = isVideo && Boolean(preview);
  const showCornerBadges = published || isGroup || showPlay;
  const cardTitle = creationCardTitle(creation);

  useEffect(() => {
    if (unavailable || !canFetchLocal(creation) || preview) return;
    void ensureLocal([creation.id], { fullMedia: false });
  }, [creation, unavailable, preview]);

  return (
    <div className="creation-card">
      <button
        type="button"
        className={[
          "creation-card-hit",
          waitingOnDisk ? "is-pending" : "",
          unavailable ? "is-broken" : "",
          isNsfw ? "is-nsfw" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => onOpen(creation)}
        aria-label={
          unavailable
            ? `${creation.title} (unavailable)`
            : `Open ${creation.title}${isNsfw ? ", NSFW" : ""}${published ? ", published" : ""}${isGroup ? ", group" : ""}${showPlay ? ", video" : ""}`
        }
      >
        <span
          className="creation-card-clip"
          style={{ aspectRatio: aspectCss }}
        >
          {preview ? (
            <img
              className="creation-thumb"
              src={preview}
              alt=""
              loading="eager"
              decoding="async"
            />
          ) : waitingOnDisk ? (
            <>
              <div
                className="creation-thumb creation-thumb-fallback"
                aria-hidden
              />
              <span className="creation-shimmer" aria-hidden />
            </>
          ) : (
            <BrokenPreview />
          )}
          {isNsfw ? <span className="creation-nsfw-frost" aria-hidden /> : null}
          {isNsfw ? <NsfwHiddenBadge /> : null}
          {showCornerBadges ? (
            <span className="creation-badge-row" aria-hidden>
              {published ? <PublishedBadge /> : null}
              {isGroup ? <GroupBadge /> : null}
              {showPlay ? <VideoPlayBadge /> : null}
            </span>
          ) : null}
          <span className="creation-meta">
            <span
              className={
                cardTitle.untitled
                  ? "creation-title is-untitled"
                  : "creation-title"
              }
            >
              {cardTitle.text}
            </span>
          </span>
        </span>
      </button>
    </div>
  );
});
