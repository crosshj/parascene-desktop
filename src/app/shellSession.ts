import {
  isFilterId,
  type FilterId,
} from "../library/creationFilters";

export type PrimaryTab = "library" | "project";
export type LibrarySurface = "creations" | "sync";
export type LayoutMode = "director" | "editor" | "hook" | "lab";

export const SHELL_SESSION_KEY = "parascene.shellSession.v1";

export type ShellSessionSnapshot = {
  primaryTab: PrimaryTab;
  librarySurface: LibrarySurface;
  mode: LayoutMode;
  openProjectId: string | null;
  selectedSceneId: string | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  hookUrl: string;
  hookRange: { startSec: number; endSec: number };
  /** Last Creations sidebar filter (restored when returning to Library). */
  creationsFilterId: FilterId;
};

export const DEFAULT_SHELL_SESSION: ShellSessionSnapshot = {
  primaryTab: "library",
  librarySurface: "creations",
  mode: "director",
  openProjectId: null,
  selectedSceneId: null,
  leftCollapsed: false,
  rightCollapsed: false,
  hookUrl: "",
  hookRange: { startSec: 0, endSec: 9 },
  creationsFilterId: "all",
};

const PRIMARY_TABS = new Set<PrimaryTab>(["library", "project"]);
const LIBRARY_SURFACES = new Set<LibrarySurface>(["creations", "sync"]);
const MODES = new Set<LayoutMode>(["director", "editor", "hook", "lab"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Load last shell UI session. `knownProjectIds` drops stale openProjectId.
 */
export function loadShellSession(
  knownProjectIds: ReadonlySet<string>,
): ShellSessionSnapshot {
  try {
    const raw = localStorage.getItem(SHELL_SESSION_KEY);
    if (!raw) return { ...DEFAULT_SHELL_SESSION };
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { ...DEFAULT_SHELL_SESSION };

    const primaryTab = PRIMARY_TABS.has(parsed.primaryTab as PrimaryTab)
      ? (parsed.primaryTab as PrimaryTab)
      : DEFAULT_SHELL_SESSION.primaryTab;
    const librarySurface = LIBRARY_SURFACES.has(
      parsed.librarySurface as LibrarySurface,
    )
      ? (parsed.librarySurface as LibrarySurface)
      : DEFAULT_SHELL_SESSION.librarySurface;
    const mode = MODES.has(parsed.mode as LayoutMode)
      ? (parsed.mode as LayoutMode)
      : DEFAULT_SHELL_SESSION.mode;

    let openProjectId: string | null =
      typeof parsed.openProjectId === "string" ? parsed.openProjectId : null;
    if (openProjectId && !knownProjectIds.has(openProjectId)) {
      openProjectId = null;
    }

    let selectedSceneId: string | null =
      typeof parsed.selectedSceneId === "string"
        ? parsed.selectedSceneId
        : null;
    if (!openProjectId) selectedSceneId = null;
    else if (!selectedSceneId) selectedSceneId = `${openProjectId}-scene-1`;

    const leftCollapsed = Boolean(parsed.leftCollapsed);
    const rightCollapsed = Boolean(parsed.rightCollapsed);
    const hookUrl =
      typeof parsed.hookUrl === "string"
        ? parsed.hookUrl
        : DEFAULT_SHELL_SESSION.hookUrl;

    let hookRange = DEFAULT_SHELL_SESSION.hookRange;
    if (isRecord(parsed.hookRange)) {
      const startSec = Number(parsed.hookRange.startSec);
      const endSec = Number(parsed.hookRange.endSec);
      if (Number.isFinite(startSec) && Number.isFinite(endSec)) {
        hookRange = { startSec, endSec };
      }
    }

    let creationsFilterId: FilterId = DEFAULT_SHELL_SESSION.creationsFilterId;
    if (isFilterId(parsed.creationsFilterId)) {
      creationsFilterId = parsed.creationsFilterId;
    }
    // In project filter only makes sense with an open project.
    if (creationsFilterId === "inProject" && !openProjectId) {
      creationsFilterId = "all";
    }

    return {
      primaryTab,
      librarySurface,
      mode,
      openProjectId,
      selectedSceneId,
      leftCollapsed,
      rightCollapsed,
      hookUrl,
      hookRange,
      creationsFilterId,
    };
  } catch {
    return { ...DEFAULT_SHELL_SESSION };
  }
}

export function saveShellSession(snapshot: ShellSessionSnapshot): void {
  try {
    localStorage.setItem(SHELL_SESSION_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore quota / private mode
  }
}
