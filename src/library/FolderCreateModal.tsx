import { useEffect, useState } from "react";

type FolderCreateModalProps = {
  onCancel: () => void;
  onCreate: (title: string) => void;
};

const FALLBACK_TITLE = "Untitled folder";

export function FolderCreateModal({
  onCancel,
  onCreate,
}: FolderCreateModalProps) {
  const [title, setTitle] = useState("");

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

  const submit = () => {
    onCreate(title.trim() || FALLBACK_TITLE);
  };

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
        aria-labelledby="folder-create-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="folder-create-title">New folder</h2>
        <label className="folder-edit-field">
          <span>Name</span>
          <input
            type="text"
            value={title}
            placeholder={FALLBACK_TITLE}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <div className="confirm-dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
