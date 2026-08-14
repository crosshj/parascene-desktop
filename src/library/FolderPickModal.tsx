import { useEffect, useState } from "react";
import { FolderCard } from "./FolderCard";
import type { LibraryFolder } from "./folderClient";
import type { Creation } from "./types";

type FolderPickModalProps = {
  folders: LibraryFolder[];
  creationsById?: ReadonlyMap<string, Creation>;
  selectedCount?: number;
  title?: string;
  onCancel: () => void;
  onPick: (folder: LibraryFolder) => void;
};

export function FolderPickModal({
  folders,
  creationsById,
  selectedCount,
  title = "Add to folder",
  onCancel,
  onPick,
}: FolderPickModalProps) {
  const [chosenId, setChosenId] = useState<string | null>(null);
  const chosen = folders.find((folder) => folder.id === chosenId) ?? null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === "Enter" && chosen) {
        event.preventDefault();
        onPick(chosen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chosen, onCancel, onPick]);

  const selectionLabel =
    selectedCount != null && selectedCount > 0
      ? `Choose a folder or project for ${selectedCount} selected ${
          selectedCount === 1 ? "item" : "items"
        }.`
      : "Choose a folder or project.";

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
        <h2 id="folder-pick-title">{title}</h2>
        {folders.length === 0 ? (
          <p className="muted">
            No folders yet. Create a folder or project from a selection.
          </p>
        ) : (
          <>
            <p className="folder-pick-subtitle muted">{selectionLabel}</p>
            <ul className="folder-pick-grid">
              {folders.map((folder) => (
                <li key={folder.id}>
                  <FolderCard
                    folder={folder}
                    selected={folder.id === chosenId}
                    creationsById={creationsById}
                    onOpen={(next) => setChosenId(next.id)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="confirm-dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!chosen}
            onClick={() => {
              if (chosen) onPick(chosen);
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
