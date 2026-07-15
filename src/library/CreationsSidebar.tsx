import type { ReactNode } from "react";
import {
  anyFilterActive,
  type CreationFilterToggles,
  type FilterCounts,
  type FilterId,
} from "./creationFilters";

type Row = {
  id: FilterId;
  label: string;
  countKey: keyof FilterCounts;
  icon: ReactNode;
  /** Secondary muted label under the main name (aspect rows). */
  sublabel?: string;
};

function Icon({ children }: { children: ReactNode }) {
  return (
    <span className="creations-filter-icon" aria-hidden>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </span>
  );
}

const MEDIA_ROWS: Row[] = [
  {
    id: "all",
    label: "All Assets",
    countKey: "all",
    icon: (
      <Icon>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </Icon>
    ),
  },
  {
    id: "video",
    label: "Videos",
    countKey: "video",
    icon: (
      <Icon>
        <path d="M15 10l4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14" />
        <rect x="3" y="6" width="12" height="12" rx="2" />
      </Icon>
    ),
  },
  {
    id: "image",
    label: "Images",
    countKey: "image",
    icon: (
      <Icon>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="9" cy="10" r="1.5" />
        <path d="M21 15l-5-5L5 19" />
      </Icon>
    ),
  },
  {
    id: "audio",
    label: "Audio",
    countKey: "audio",
    icon: (
      <Icon>
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </Icon>
    ),
  },
  {
    id: "groups",
    label: "Groups",
    countKey: "groups",
    icon: (
      <Icon>
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <rect x="5" y="5" width="11" height="11" rx="2" />
      </Icon>
    ),
  },
  {
    id: "localOnly",
    label: "Local-only",
    countKey: "localOnly",
    icon: (
      <Icon>
        <ellipse cx="12" cy="6" rx="7" ry="3" />
        <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
        <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
      </Icon>
    ),
  },
  {
    id: "published",
    label: "Published",
    countKey: "published",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </Icon>
    ),
  },
  {
    id: "unpublished",
    label: "Unpublished",
    countKey: "unpublished",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="10" />
        <polygon points="10 8 16 12 10 16 10 8" />
      </Icon>
    ),
  },
];

const ASPECT_ROWS: Row[] = [
  {
    id: "aspect11",
    label: "1:1",
    sublabel: "square",
    countKey: "aspect11",
    icon: (
      <Icon>
        <rect x="6" y="6" width="12" height="12" rx="1.5" />
      </Icon>
    ),
  },
  {
    id: "aspect916",
    label: "9:16",
    sublabel: "phone",
    countKey: "aspect916",
    icon: (
      <Icon>
        <rect x="8" y="3" width="8" height="18" rx="1.5" />
      </Icon>
    ),
  },
  {
    id: "aspect45",
    label: "4:5",
    sublabel: "portrait",
    countKey: "aspect45",
    icon: (
      <Icon>
        <rect x="7" y="4" width="10" height="16" rx="1.5" />
      </Icon>
    ),
  },
  {
    id: "aspect169",
    label: "16:9",
    sublabel: "cinema",
    countKey: "aspect169",
    icon: (
      <Icon>
        <rect x="3" y="7" width="18" height="10" rx="1.5" />
      </Icon>
    ),
  },
];

const SELECTION_FILTER_ROWS: Row[] = [
  {
    id: "selected",
    label: "Selected",
    countKey: "selected",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <path d="M8.5 12.5l2.5 2.5 4.5-5" />
      </Icon>
    ),
  },
  {
    id: "notSelected",
    label: "Not selected",
    countKey: "notSelected",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
      </Icon>
    ),
  },
  {
    id: "inProject",
    label: "In project",
    countKey: "inProject",
    icon: (
      <Icon>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        <path d="M9 13l2 2 4-4" />
      </Icon>
    ),
  },
];

function rowActive(id: FilterId, toggles: CreationFilterToggles): boolean {
  if (id === "all") return !anyFilterActive(toggles);
  return toggles[id];
}

function FilterButton({
  row,
  toggles,
  counts,
  onToggle,
}: {
  row: Row;
  toggles: CreationFilterToggles;
  counts: FilterCounts;
  onToggle: (id: FilterId) => void;
}) {
  const active = rowActive(row.id, toggles);
  return (
    <button
      type="button"
      className={
        active ? "creations-filter-btn is-active" : "creations-filter-btn"
      }
      aria-pressed={active}
      onClick={() => onToggle(row.id)}
    >
      {row.icon}
      <span className="creations-filter-label">
        {row.label}
        {row.sublabel ? (
          <span className="creations-filter-sublabel"> {row.sublabel}</span>
        ) : null}
      </span>
      <span className="creations-filter-count">{counts[row.countKey]}</span>
    </button>
  );
}

export function CreationsSidebar({
  toggles,
  counts,
  width,
  onToggle,
  selectedCount = 0,
  hasOpenProject = false,
  onNewProject,
  onAddToProject,
  onClearSelection,
  onAddFromDisk,
  importing = false,
}: {
  toggles: CreationFilterToggles;
  counts: FilterCounts;
  width: number;
  onToggle: (id: FilterId) => void;
  selectedCount?: number;
  hasOpenProject?: boolean;
  onNewProject?: () => void;
  onAddToProject?: () => void;
  onClearSelection?: () => void;
  onAddFromDisk?: () => void;
  importing?: boolean;
}) {
  const showSelectionActions = selectedCount > 0;

  return (
    <aside
      className="creations-sidebar"
      style={{ width }}
      aria-label="Creation filters"
    >
      <p className="creations-sidebar-title">Library</p>
      {onAddFromDisk ? (
        <div className="creations-sidebar-actions creations-sidebar-import">
          <button
            type="button"
            className="creations-sidebar-action-btn"
            onClick={onAddFromDisk}
            disabled={importing}
          >
            {importing ? "Adding…" : "Add from disk…"}
          </button>
        </div>
      ) : null}
      {MEDIA_ROWS.map((row) => (
        <FilterButton
          key={row.id}
          row={row}
          toggles={toggles}
          counts={counts}
          onToggle={onToggle}
        />
      ))}

      <p className="creations-sidebar-title creations-sidebar-section">Aspect</p>
      {ASPECT_ROWS.map((row) => (
        <FilterButton
          key={row.id}
          row={row}
          toggles={toggles}
          counts={counts}
          onToggle={onToggle}
        />
      ))}

      <p className="creations-sidebar-title creations-sidebar-section">
        Selection
      </p>
      {SELECTION_FILTER_ROWS.filter(
        (row) => row.id !== "inProject" || hasOpenProject,
      ).map((row) => (
        <FilterButton
          key={row.id}
          row={row}
          toggles={toggles}
          counts={counts}
          onToggle={onToggle}
        />
      ))}

      {showSelectionActions ? (
        <div className="creations-sidebar-actions" aria-label="Selection actions">
          <p className="creations-sidebar-actions-count">
            {selectedCount} selected
          </p>
          <button
            type="button"
            className="creations-sidebar-action-btn"
            onClick={onNewProject}
          >
            New project…
          </button>
          {hasOpenProject ? (
            <button
              type="button"
              className="creations-sidebar-action-btn"
              onClick={onAddToProject}
            >
              Add to project…
            </button>
          ) : null}
          <button
            type="button"
            className="creations-sidebar-action-btn is-muted"
            onClick={onClearSelection}
          >
            Clear
          </button>
        </div>
      ) : null}
    </aside>
  );
}
