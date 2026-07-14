import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LayoutMode } from "../project/types";
import {
  defaultProjectRepository,
} from "../fixtures/mockProject";
import type { Project, ProjectRepository } from "../project/types";

type ShellState = {
  mode: LayoutMode;
  setMode: (mode: LayoutMode) => void;
  project: Project;
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
  const [mode, setMode] = useState<LayoutMode>("director");
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(
    project.scenes[0]?.id ?? null,
  );
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [hookUrl, setHookUrl] = useState("");
  const [hookRange, setHookRange] = useState({ startSec: 0, endSec: 9 });

  const toggleLeft = useCallback(() => setLeftCollapsed((v) => !v), []);
  const toggleRight = useCallback(() => setRightCollapsed((v) => !v), []);

  const value = useMemo(
    () => ({
      mode,
      setMode,
      project,
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
      mode,
      project,
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
