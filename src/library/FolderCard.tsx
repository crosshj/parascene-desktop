import { memo, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { getCreation } from "./catalogClient";
import type { LibraryFolder } from "./folderClient";
import { creationPreviewUrl } from "./previewUrl";

type FolderCardProps = {
  folder: LibraryFolder;
  selected?: boolean;
  onOpen: (folder: LibraryFolder) => void;
  onToggleSelect?: (folder: LibraryFolder) => void;
  onContextMenu?: (
    folder: LibraryFolder,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
};

function FolderGlyph() {
  return (
    <div className="folder-card-empty" aria-hidden>
      <svg viewBox="0 0 24 24" width="36" height="36" fill="none">
        <path
          d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}

function FolderCollage({ memberIds }: { memberIds: string[] }) {
  const ids = memberIds.slice(0, 4);
  const [urls, setUrls] = useState<(string | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      ids.map(async (id) => {
        try {
          const creation = await getCreation(id);
          return creationPreviewUrl(creation);
        } catch {
          return null;
        }
      }),
    ).then((next) => {
      if (!cancelled) setUrls(next);
    });
    return () => {
      cancelled = true;
    };
  }, [ids.join("|")]);

  if (ids.length === 0) return <FolderGlyph />;

  return (
    <div
      className={`folder-card-collage is-count-${Math.min(ids.length, 4)}`}
      aria-hidden
    >
      {ids.map((id, index) => {
        const src = urls[index];
        return (
          <div key={id} className="folder-card-collage-cell">
            {src ? <img src={src} alt="" draggable={false} /> : null}
          </div>
        );
      })}
    </div>
  );
}

export const FolderCard = memo(function FolderCard({
  folder,
  selected = false,
  onOpen,
  onToggleSelect,
  onContextMenu,
}: FolderCardProps) {
  return (
    <button
      type="button"
      className={`folder-card${selected ? " is-selected" : ""}`}
      onClick={(event) => {
        if (event.shiftKey && onToggleSelect) {
          event.preventDefault();
          onToggleSelect(folder);
          return;
        }
        onOpen(folder);
      }}
      onContextMenu={
        onContextMenu
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu(folder, event);
            }
          : undefined
      }
    >
      <div className="folder-card-thumb">
        <FolderCollage memberIds={folder.memberIds} />
      </div>
      <span className="folder-card-title">{folder.title}</span>
      <span className="folder-card-meta muted">
        {folder.memberCount} {folder.memberCount === 1 ? "item" : "items"}
      </span>
    </button>
  );
});
