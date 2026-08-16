/** Centered empty state for an opened Library folder with no members. */
export function FolderEmpty({
  title,
  canDelete,
  onDelete,
}: {
  title: string;
  canDelete: boolean;
  onDelete?: () => void;
}) {
  return (
    <div className="creations-filter-empty" role="status">
      <p className="creations-filter-empty-title">Empty folder</p>
      <p className="creations-filter-empty-copy">
        “{title}” has no items.
        {canDelete ? " You can delete it." : ""}
      </p>
      {canDelete && onDelete ? (
        <button
          type="button"
          className="btn btn-danger"
          onClick={onDelete}
        >
          Delete folder
        </button>
      ) : null}
    </div>
  );
}

/** Centered empty state for filter views with no matches. */
export function CreationsFilterEmpty() {
  return (
    <div className="creations-filter-empty" role="status">
      <svg
        className="creations-filter-empty-icon"
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden
      >
        <rect
          x="10"
          y="14"
          width="36"
          height="28"
          rx="3"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity="0.45"
        />
        <rect
          x="18"
          y="22"
          width="36"
          height="28"
          rx="3"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M26 36h20M30 42h12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.7"
        />
        <circle
          cx="48"
          cy="48"
          r="11"
          fill="var(--bg)"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M48 43v6M48 52.5v.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <p className="creations-filter-empty-title">Nothing found</p>
      <p className="creations-filter-empty-copy">
        No creations match this view.
      </p>
    </div>
  );
}
