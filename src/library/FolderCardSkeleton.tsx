import { memo } from "react";

/** Board folder tile placeholder while collage / filter data is still loading. */
export const FolderCardSkeleton = memo(function FolderCardSkeleton() {
  return (
    <div
      className="folder-card folder-card-skeleton is-board"
      aria-hidden
    >
      <div className="folder-card-thumb" />
    </div>
  );
});
