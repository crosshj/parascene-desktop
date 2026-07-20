import { creationCardTitle } from "../library/creationFlags";
import { creationPreviewUrl } from "../library/previewUrl";
import type { Creation } from "../library/types";

/** Thumbnail grid for picking a project image (e.g. a2v still). */
export function LabImagePicker({
  images,
  value,
  onChange,
}: {
  images: Creation[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (images.length === 0) {
    return <p className="muted">No images in this project.</p>;
  }

  return (
    <div className="lab-image-picker" role="listbox" aria-label="Still image">
      {images.map((creation) => {
        const preview = creationPreviewUrl(creation);
        const selected = creation.id === value;
        const title = creationCardTitle(creation).text;
        return (
          <button
            key={creation.id}
            type="button"
            role="option"
            aria-selected={selected}
            className={`lab-image-picker-item${selected ? " is-selected" : ""}`}
            title={title}
            onClick={() => onChange(creation.id)}
          >
            <span className="lab-image-picker-thumb">
              {preview ? (
                <img src={preview} alt="" loading="lazy" />
              ) : (
                <span className="lab-image-picker-fallback muted">No preview</span>
              )}
            </span>
            <span className="lab-image-picker-label">{title}</span>
          </button>
        );
      })}
    </div>
  );
}
