import { creationCardTitle } from "../library/creationFlags";
import { creationPreviewUrl } from "../library/previewUrl";
import type { Creation } from "../library/types";

/** Thumbnail grid for picking a project image or video. */
export function LabImagePicker({
  images,
  value,
  onChange,
  onPreview,
  mediaLabel,
}: {
  images: Creation[];
  value: string;
  onChange: (id: string) => void;
  /** When provided, a Preview link appears under each thumb to open a lightbox. */
  onPreview?: (creation: Creation) => void;
  /** Override the empty-state and aria label (default "images"). */
  mediaLabel?: string;
}) {
  const label = mediaLabel || "images";
  if (images.length === 0) {
    return <p className="muted">No {label} in this project.</p>;
  }

  return (
    <div className="lab-image-picker" role="listbox" aria-label={label}>
      {images.map((creation) => {
        const preview = creationPreviewUrl(creation);
        const selected = creation.id === value;
        const title = creationCardTitle(creation).text;
        return (
          <div
            key={creation.id}
            className={`lab-image-picker-item${selected ? " is-selected" : ""}`}
          >
            <button
              type="button"
              role="option"
              aria-selected={selected}
              className="lab-image-picker-select"
              title={title}
              onClick={() => onChange(creation.id)}
            >
              <span className="lab-image-picker-thumb">
                {preview ? (
                  <img src={preview} alt="" loading="lazy" />
                ) : (
                  <span className="lab-image-picker-fallback muted">
                    No preview
                  </span>
                )}
              </span>
              <span className="lab-image-picker-label">{title}</span>
            </button>
            {onPreview ? (
              <button
                type="button"
                className="lab-inline-link lab-image-picker-preview-link"
                onClick={() => onPreview(creation)}
              >
                Preview
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
