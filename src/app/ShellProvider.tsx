import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LayoutMode } from "../project/types";
import { defaultProjectRepository } from "../fixtures/mockProject";
import type { Project, ProjectRepository } from "../project/types";

export type PrimaryTab = "library" | "project";
export type LibrarySurface = "creations" | "sync";

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

export function ShellProvider({
  children,
  repository = defaultProjectRepository,
}: {
  children: ReactNode;
  repository?: ProjectRepository;
}) {
  const project = useMemo(() => repository.getProject(), [repository]);
  const recentProjects = useMemo(
    () => [{ id: project.id, title: project.title }],
    [project],
  );

  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>("library");
  const [librarySurface, setLibrarySurface] =
    useState<LibrarySurface>("creations");
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [mode, setMode] = useState<LayoutMode>("director");
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(
    project.scenes[0]?.id ?? null,
  );
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [hookUrl, setHookUrl] = useState("");
  const [hookRange, setHookRange] = useState({ startSec: 0, endSec: 9 });
  const [chromeStatus, setChromeStatusState] = useState<string | null>(null);
  const setChromeStatus = useCallback((status: string | null) => {
    setChromeStatusState((prev) => (prev === status ? prev : status));
  }, []);

  const toggleLeft = useCallback(() => setLeftCollapsed((v) => !v), []);
  const toggleRight = useCallback(() => setRightCollapsed((v) => !v), []);

  const openProject = useCallback(
    (id: string) => {
      setOpenProjectId(id);
      setPrimaryTab("project");
      setMode("director");
      setSelectedSceneId(project.scenes[0]?.id ?? null);
    },
    [project.scenes],
  );

  const closeProject = useCallback(() => {
    setOpenProjectId(null);
    setPrimaryTab("project");
  }, []);

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
