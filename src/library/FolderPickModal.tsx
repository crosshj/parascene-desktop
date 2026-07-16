import { useEffect } from "react";
import type { LibraryFolder } from "./folderClient";

type FolderPickModalProps = {
  folders: LibraryFolder[];
  onCancel: () => void;
  onPick: (folder: LibraryFolder) => void;
};

export function FolderPickModal({
  folders,
  onCancel,
  onPick,
}: FolderPickModalProps) {
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
        className="confirm-dialog folder-pick-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-pick-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="folder-pick-title">Add to folder</h2>
        {folders.length === 0 ? (
          <p className="muted">No folders yet. Create one from a selection.</p>
        ) : (
          <ul className="folder-pick-list">
            {folders.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  className="folder-pick-item"
                  onClick={() => onPick(folder)}
                >
                  <span>{folder.title}</span>
                  <span className="muted">
                    {folder.memberCount}{" "}
                    {folder.memberCount === 1 ? "item" : "items"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="confirm-dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
