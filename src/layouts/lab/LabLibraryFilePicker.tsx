/**
 * Shared Library media dialog for Lab run forms (Replicate + Blue).
 */

import { LabImagePicker } from "../../lab/LabImagePicker";
import { creationCardTitle } from "../../library/creationFlags";
import type { Creation } from "../../library/types";
import type { ReplicateInputField } from "../../replicate/replicateClient";
import { fileFieldKind, type FileFieldKind } from "./labSchemaForm";

export type LabRunFilePick =
  | { kind: "path"; path: string }
  | { kind: "creation"; creationId: string };

export function LabLibraryFilePickerDialog({
  fieldName,
  field,
  pick,
  pickerImages,
  pickerAudio,
  pickerVideo,
  onClose,
  onPickCreation,
}: {
  fieldName: string;
  field: ReplicateInputField | null;
  pick: LabRunFilePick | null;
  pickerImages: Creation[];
  pickerAudio: Creation[];
  pickerVideo: Creation[];
  onClose: () => void;
  onPickCreation: (id: string) => void;
}) {
  const kind: FileFieldKind = field ? fileFieldKind(field) : "any";
  const selectedId = pick?.kind === "creation" ? pick.creationId : "";
  const title =
    kind === "audio"
      ? "Choose audio"
      : kind === "video"
        ? "Choose video"
        : kind === "image"
          ? "Choose image"
          : "Choose file";

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="confirm-dialog lab-replicate-image-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lab-library-file-picker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="lab-library-file-picker-title">{title}</h2>
        <p className="muted">
          Pick a Library asset for <code>{fieldName}</code>. Local disk files
          can be chosen from the run form without opening this dialog.
        </p>
        <div className="lab-replicate-image-picker-body">
          {kind === "image" || kind === "any" ? (
            <LabImagePicker
              images={
                kind === "any"
                  ? [...pickerImages, ...pickerVideo]
                  : pickerImages
              }
              value={selectedId}
              mediaLabel={
                kind === "any" ? "Library images & videos" : "Library images"
              }
              onChange={onPickCreation}
            />
          ) : null}
          {kind === "audio" || kind === "any" ? (
            <div className="lab-replicate-audio-list">
              {pickerAudio.length === 0 ? (
                kind === "audio" ? (
                  <p className="muted">No audio in Library or this project.</p>
                ) : null
              ) : (
                <label className="lab-replicate-run-field">
                  <span className="lab-replicate-run-field-name">Audio</span>
                  <select
                    className="control"
                    value={
                      pickerAudio.some((c) => c.id === selectedId)
                        ? selectedId
                        : ""
                    }
                    onChange={(e) => {
                      const id = e.target.value;
                      if (id) onPickCreation(id);
                    }}
                    aria-label="Library audio"
                  >
                    <option value="">Select audio…</option>
                    {pickerAudio.map((c) => (
                      <option key={c.id} value={c.id}>
                        {creationCardTitle(c).text}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          ) : null}
          {kind === "video" ? (
            <LabImagePicker
              images={pickerVideo}
              value={selectedId}
              mediaLabel="Library videos"
              onChange={onPickCreation}
            />
          ) : null}
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
