import { useEffect, useState } from "react";
import type { LibraryFolder } from "./folderClient";

type FolderEditModalProps = {
  folder: LibraryFolder;
  onCancel: () => void;
  onSave: (title: string, description: string) => void;
};

export function FolderEditModal({
  folder,
  onCancel,
  onSave,
}: FolderEditModalProps) {
  const [title, setTitle] = useState(folder.title);
  const [description, setDescription] = useState(folder.description);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={onCancel}
    >
      <div
        className="confirm-dialog folder-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-edit-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="folder-edit-title">Edit folder</h2>
        <label className="folder-edit-field">
          <span>Name</span>
          <input
            type="text"
            value={title}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="folder-edit-field">
          <span>Description</span>
          <textarea
            value={description}
            rows={4}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <div className="confirm-dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onSave(title.trim() || "Untitled folder", description)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
