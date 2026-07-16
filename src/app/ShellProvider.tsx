import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LayoutMode, Project, TimelineClip } from "../project/types";
import type { ProjectAspectRatio } from "../project/aspectRatios";
import {
  createStoredProject,
  emptyUiProject,
  loadStoredProjects,
  mergeCreationIds,
  mergeFolderIds,
  removeCreationIds,
  removeFolderIds,
  renameStoredProject,
  saveStoredProjects,
  setStoredProjectAspectRatio,
  setStoredProjectSelectedTimelineClipId,
  setStoredProjectSelectedAssetId,
  setStoredProjectTimeline,
  setStoredProjectTimelineZoom,
  setStoredProjectTimelineMonitorActive,
  setStoredProjectTimelinePlayheadSec,
  storedProjectToUi,
  type StoredProject,
} from "../project/projectStore";
import {
  loadShellSession,
  saveShellSession,
  type LibrarySurface,
  type PrimaryTab,
} from "./shellSession";
import type { FilterId } from "../library/creationFilters";

export type { PrimaryTab, LibrarySurface } from "./shellSession";

type ShellState = {
  primaryTab: PrimaryTab;
  setPrimaryTab: (tab: PrimaryTab) => void;
  librarySurface: LibrarySurface;
  setLibrarySurface: (surface: LibrarySurface) => void;
  mode: LayoutMode;
  setMode: (mode: LayoutMode) => void;
  /** Null means no project open (Project tab shows the picker). */
  openProjectId: string | null;
  openProject: (id: string) => void;
  closeProject: () => void;
  /** Create a project (optionally from library creation IDs) and open it. */
  createProject: (title: string, creationIds?: string[]) => string;
  /** Rename the open project (no-op if none open). */
  renameOpenProject: (title: string) => void;
  /** Set the open project's creative aspect ratio (no-op if none open). */
  setOpenProjectAspectRatio: (aspectRatio: ProjectAspectRatio) => void;
  /** Replace the open project's timeline clips (no-op if none open). */
  setOpenProjectTimeline: (timeline: TimelineClip[]) => void;
  /** Remember which timeline clip is selected in the editor. */
  setOpenProjectSelectedTimelineClipId: (clipId: string | null) => void;
  /** Remember which asset is selected in the editor. */
  setOpenProjectSelectedAssetId: (assetId: string | null) => void;
  /** Remember timeline zoom for the open project. */
  setOpenProjectTimelineZoom: (zoom: number) => void;
  /** Remember whether the preview follows the timeline. */
  setOpenProjectTimelineMonitorActive: (active: boolean) => void;
  /** Remember timeline playhead position (seconds). */
  setOpenProjectTimelinePlayheadSec: (sec: number) => void;
  /** Append library creation IDs into the open project (no-op if none open). */
  addCreationsToOpenProject: (creationIds: string[]) => void;
  /** Remove library creation IDs from the open project (no-op if none open). */
  removeCreationsFromOpenProject: (creationIds: string[]) => void;
  /** Attach local Library folders (and their members) to the open project. */
  addFoldersToOpenProject: (
    folderIds: string[],
    memberCreationIds: string[],
  ) => void;
  /** Detach local Library folders from the open project (members stay). */
  removeFoldersFromOpenProject: (folderIds: string[]) => void;
  /** Last Creations filter — survives Library ↔ Project switches. */
  creationsFilterId: FilterId;
  setCreationsFilterId: (id: FilterId) => void;
  /** Quiet status for the app header (e.g. "Showing 40 of 200"). */
  chromeStatus: string | null;
  setChromeStatus: (status: string | null) => void;
  project: Project;
  recentProjects: { id: string; title: string }[];
  selectedSceneId: string | null;
  setSelectedSceneId: (id: string | null) => void;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;
  hookUrl: string;
  setHookUrl: (url: string) => void;
  hookRange: { startSec: number; endSec: number };
  setHookRange: (range: { startSec: number; endSec: number }) => void;
};

const ShellContext = createContext<ShellState | null>(null);

function sortByUpdatedDesc(projects: StoredProject[]): StoredProject[] {
  return [...projects].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [storedProjects, setStoredProjects] = useState<StoredProject[]>(() =>
    sortByUpdatedDesc(loadStoredProjects()),
  );

  const initialSession = useMemo(() => {
    const ids = new Set(loadStoredProjects().map((p) => p.id));
    return loadShellSession(ids);
  }, []);

  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>(
    initialSession.primaryTab,
  );
  const [librarySurface, setLibrarySurface] = useState<LibrarySurface>(
    initialSession.librarySurface,
  );
  const [openProjectId, setOpenProjectId] = useState<string | null>(
    initialSession.openProjectId,
  );
  const [mode, setMode] = useState<LayoutMode>(initialSession.mode);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(
    initialSession.selectedSceneId,
  );
  const [leftCollapsed, setLeftCollapsed] = useState(
    initialSession.leftCollapsed,
  );
  const [rightCollapsed, setRightCollapsed] = useState(
    initialSession.rightCollapsed,
  );
  const [hookUrl, setHookUrl] = useState(initialSession.hookUrl);
  const [hookRange, setHookRange] = useState(initialSession.hookRange);
  const [creationsFilterId, setCreationsFilterId] = useState<FilterId>(
    initialSession.creationsFilterId,
  );
  const [chromeStatus, setChromeStatusState] = useState<string | null>(null);
  const setChromeStatus = useCallback((status: string | null) => {
    setChromeStatusState((prev) => (prev === status ? prev : status));
  }, []);

  useEffect(() => {
    saveShellSession({
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
    });
  }, [
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
  ]);

  // Drop In project filter memory when the project closes.
  useEffect(() => {
    if (openProjectId) return;
    if (creationsFilterId === "inProject") setCreationsFilterId("all");
  }, [creationsFilterId, openProjectId]);

  /** Functional update so rapid sequential writes (e.g. activate + scrub) compose. */
  const updateStoredProjects = useCallback(
    (updater: (prev: StoredProject[]) => StoredProject[]) => {
      setStoredProjects((prev) => {
        const sorted = sortByUpdatedDesc(updater(prev));
        saveStoredProjects(sorted);
        return sorted;
      });
    },
    [],
  );

  const patchOpenProject = useCallback(
    (patch: (project: StoredProject) => StoredProject) => {
      if (!openProjectId) return;
      const id = openProjectId;
      updateStoredProjects((prev) =>
        prev.map((p) => (p.id === id ? patch(p) : p)),
      );
    },
    [openProjectId, updateStoredProjects],
  );

  const project = useMemo(() => {
    if (!openProjectId) return emptyUiProject();
    const found = storedProjects.find((p) => p.id === openProjectId);
    return found ? storedProjectToUi(found) : emptyUiProject();
  }, [openProjectId, storedProjects]);

  const recentProjects = useMemo(
    () => storedProjects.map((p) => ({ id: p.id, title: p.title })),
    [storedProjects],
  );

  const toggleLeft = useCallback(() => setLeftCollapsed((v) => !v), []);
  const toggleRight = useCallback(() => setRightCollapsed((v) => !v), []);

  const openProject = useCallback(
    (id: string) => {
      const found = storedProjects.find((p) => p.id === id);
      if (!found) return;
      setOpenProjectId(id);
      setPrimaryTab("project");
      setMode("director");
      setSelectedSceneId(`${id}-scene-1`);
    },
    [storedProjects],
  );

  const closeProject = useCallback(() => {
    setOpenProjectId(null);
    setSelectedSceneId(null);
    setPrimaryTab("project");
  }, []);

  const createProject = useCallback(
    (title: string, creationIds: string[] = []) => {
      const created = createStoredProject(title, creationIds);
      updateStoredProjects((prev) => [
        created,
        ...prev.filter((p) => p.id !== created.id),
      ]);
      setOpenProjectId(created.id);
      setPrimaryTab("project");
      setMode("director");
      setSelectedSceneId(`${created.id}-scene-1`);
      return created.id;
    },
    [updateStoredProjects],
  );

  const addCreationsToOpenProject = useCallback(
    (creationIds: string[]) => {
      if (creationIds.length === 0) return;
      patchOpenProject((p) => mergeCreationIds(p, creationIds));
    },
    [patchOpenProject],
  );

  const removeCreationsFromOpenProject = useCallback(
    (creationIds: string[]) => {
      if (creationIds.length === 0) return;
      patchOpenProject((p) => removeCreationIds(p, creationIds));
    },
    [patchOpenProject],
  );

  const addFoldersToOpenProject = useCallback(
    (folderIds: string[], memberCreationIds: string[]) => {
      if (folderIds.length === 0 && memberCreationIds.length === 0) return;
      patchOpenProject((p) => mergeFolderIds(p, folderIds, memberCreationIds));
    },
    [patchOpenProject],
  );

  const removeFoldersFromOpenProject = useCallback(
    (folderIds: string[]) => {
      if (folderIds.length === 0) return;
      patchOpenProject((p) => removeFolderIds(p, folderIds));
    },
    [patchOpenProject],
  );

  const renameOpenProject = useCallback(
    (title: string) => {
      patchOpenProject((p) => renameStoredProject(p, title));
    },
    [patchOpenProject],
  );

  const setOpenProjectAspectRatio = useCallback(
    (aspectRatio: ProjectAspectRatio) => {
      patchOpenProject((p) => setStoredProjectAspectRatio(p, aspectRatio));
    },
    [patchOpenProject],
  );

  const setOpenProjectTimeline = useCallback(
    (timeline: TimelineClip[]) => {
      patchOpenProject((p) => setStoredProjectTimeline(p, timeline));
    },
    [patchOpenProject],
  );

  const setOpenProjectSelectedTimelineClipId = useCallback(
    (clipId: string | null) => {
      patchOpenProject((p) => setStoredProjectSelectedTimelineClipId(p, clipId));
    },
    [patchOpenProject],
  );

  const setOpenProjectSelectedAssetId = useCallback(
    (assetId: string | null) => {
      patchOpenProject((p) => setStoredProjectSelectedAssetId(p, assetId));
    },
    [patchOpenProject],
  );

  const setOpenProjectTimelineZoom = useCallback(
    (zoom: number) => {
      patchOpenProject((p) => setStoredProjectTimelineZoom(p, zoom));
    },
    [patchOpenProject],
  );

  const setOpenProjectTimelineMonitorActive = useCallback(
    (active: boolean) => {
      patchOpenProject((p) => setStoredProjectTimelineMonitorActive(p, active));
    },
    [patchOpenProject],
  );

  const setOpenProjectTimelinePlayheadSec = useCallback(
    (sec: number) => {
      patchOpenProject((p) => setStoredProjectTimelinePlayheadSec(p, sec));
    },
    [patchOpenProject],
  );

  const value = useMemo(
    () => ({
      primaryTab,
      setPrimaryTab,
      librarySurface,
      setLibrarySurface,
      mode,
      setMode,
      openProjectId,
      openProject,
      closeProject,
      createProject,
      renameOpenProject,
      setOpenProjectAspectRatio,
      setOpenProjectTimeline,
      setOpenProjectSelectedTimelineClipId,
      setOpenProjectSelectedAssetId,
      setOpenProjectTimelineZoom,
      setOpenProjectTimelineMonitorActive,
      setOpenProjectTimelinePlayheadSec,
      addCreationsToOpenProject,
      removeCreationsFromOpenProject,
      addFoldersToOpenProject,
      removeFoldersFromOpenProject,
      creationsFilterId,
      setCreationsFilterId,
      chromeStatus,
      setChromeStatus,
      project,
      recentProjects,
      selectedSceneId,
      setSelectedSceneId,
      leftCollapsed,
      rightCollapsed,
      toggleLeft,
      toggleRight,
      hookUrl,
      setHookUrl,
      hookRange,
      setHookRange,
    }),
    [
      primaryTab,
      librarySurface,
      mode,
      openProjectId,
      openProject,
      closeProject,
      createProject,
      renameOpenProject,
      setOpenProjectAspectRatio,
      setOpenProjectTimeline,
      setOpenProjectSelectedTimelineClipId,
      setOpenProjectSelectedAssetId,
      setOpenProjectTimelineZoom,
      setOpenProjectTimelineMonitorActive,
      setOpenProjectTimelinePlayheadSec,
      addCreationsToOpenProject,
      removeCreationsFromOpenProject,
      addFoldersToOpenProject,
      removeFoldersFromOpenProject,
      creationsFilterId,
      chromeStatus,
      project,
      recentProjects,
      selectedSceneId,
      leftCollapsed,
      rightCollapsed,
      toggleLeft,
      toggleRight,
      hookUrl,
      hookRange,
    ],
  );

  return (
    <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
  );
}

export function useShell(): ShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within ShellProvider");
  return ctx;
}
