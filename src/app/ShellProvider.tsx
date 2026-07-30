import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LayoutMode, LyricAlignment, Project, StoryboardGenerationPlan, StoryboardProposal, TimelineClip } from "../project/types";
import type { ProjectAspectRatio } from "../project/aspectRatios";
import type { ProjectLookId } from "../project/looks";
import { ConfirmProvider } from "../ui/ConfirmDialog";
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
  setStoredProjectLookEnabled,
  setStoredProjectSelectedTimelineClipId,
  setStoredProjectSelectedAssetId,
  setStoredProjectPendingStagedDraft,
  setStoredProjectTimeline,
  setStoredProjectTimelineZoom,
  setStoredProjectTimelineMonitorActive,
  setStoredProjectTimelinePlayheadSec,
  setStoredProjectGroupIds,
  setStoredProjectLabPrompts,
  setStoredProjectMainAudioCreationId,
  setStoredProjectLyricAlignment,
  setStoredProjectStoryboardProposal,
  patchStoredProjectStoryboardGenerationPlan,
  setStoredProjectLabStoryboardDirection,
  storedProjectToUi,
  type StoredProject,
} from "../project/projectStore";
import {
  collectProjectGroupCoverIdsToRefresh,
  reconcileStoredProjectsFromLibrary,
} from "../project/reconcileProjectLibrary";
import {
  refreshCreationsFromListById,
  syncGroupMembersManifest,
} from "../sync/manifestSync";
import {
  bindAddAssetGenerationApplier,
  type AddAssetGenerationSuccess,
} from "../layouts/editor/addAssetGenerationStore";
import { replaceAddAssetPlaceholderWithVideo } from "../layouts/editor/addAssetGenerate";
import { applyManifest, getCreation } from "../library/catalogClient";
import { creationUpsertWithAddAssetGeneration } from "../project/desktopAddAssetGeneration";
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
  /** Enable/disable a project Look (export-time filter). */
  setOpenProjectLookEnabled: (lookId: ProjectLookId, enabled: boolean) => void;
  /** Replace the open project's timeline clips (no-op if none open). */
  setOpenProjectTimeline: (
    timeline:
      | TimelineClip[]
      | ((prev: TimelineClip[]) => TimelineClip[]),
  ) => void;
  /** Remember which timeline clip is selected in the editor. */
  setOpenProjectSelectedTimelineClipId: (clipId: string | null) => void;
  /** Remember which asset is selected in the editor. */
  setOpenProjectSelectedAssetId: (assetId: string | null) => void;
  /**
   * Promote creation ids onto the open project and set the primary selection
   * in one store write (so normalizeSelectedAssetId sees the new ids).
   */
  selectCreationsOnOpenProject: (
    creationIds: string[],
    primaryId: string | null,
  ) => void;
  setOpenProjectPendingStagedDraft: (draft: unknown | null) => void;
  /** Remember timeline zoom for the open project. */
  setOpenProjectTimelineZoom: (zoom: number) => void;
  /** Remember whether the preview follows the timeline. */
  setOpenProjectTimelineMonitorActive: (active: boolean) => void;
  /** Remember timeline playhead position (seconds). */
  setOpenProjectTimelinePlayheadSec: (sec: number) => void;
  /** Persist Parascene Images / Videos group creation ids for the open project. */
  setOpenProjectGroupIds: (ids: {
    imagesGroupId?: string | null;
    videosGroupId?: string | null;
  }) => void;
  /** Persist Lab still / animate prompts for the open project. */
  setOpenProjectLabPrompts: (prompts: {
    labStillPrompt?: string | null;
    labAnimatePrompt?: string | null;
  }) => void;
  /** Persist preferred main song creation id for the open project. */
  setOpenProjectMainAudioCreationId: (creationId: string | null) => void;
  /** Persist lyric alignment for the open project. */
  setOpenProjectLyricAlignment: (alignment: LyricAlignment | null) => void;
  /** Persist MV storyboard proposal for the open project. */
  setOpenProjectStoryboardProposal: (proposal: StoryboardProposal | null) => void;
  /** Patch MV generation plan against the latest stored storyboard proposal. */
  patchOpenProjectStoryboardGenerationPlan: (
    mutate: (
      plan: StoryboardGenerationPlan | undefined,
      proposal: StoryboardProposal,
    ) => StoryboardGenerationPlan,
  ) => void;
  /** Persist MV Concept seed direction for the open project. */
  setOpenProjectLabStoryboardDirection: (direction: string | null) => void;
  /** Append library creation IDs into the open project (no-op if none open). */
  addCreationsToOpenProject: (creationIds: string[]) => void;
  /**
   * After Library sync: refresh project group covers, expand embedded members,
   * and merge missing folder/cabinet/group members into every stored project.
   */
  reconcileProjectsAfterLibrarySync: (opts?: {
    /** Re-fetch project group covers from list pages (needed after newest sync). */
    refreshCoversFromList?: boolean;
  }) => Promise<{
    projectsUpdated: number;
    creationsMerged: number;
    creationsRemoved: number;
  }>;
  /** Remove library creation IDs from the open project (no-op if none open). */
  removeCreationsFromOpenProject: (creationIds: string[]) => void;
  /** Attach local Library folders (and their members) to the open project. */
  addFoldersToOpenProject: (
    folderIds: string[],
    memberCreationIds: string[],
  ) => void;
  /** Detach local Library folders from the open project (and their members). */
  removeFoldersFromOpenProject: (
    folderIds: string[],
    memberCreationIds?: string[],
  ) => void;
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

const SHELL_CONTEXT_KEY = "__parasceneShellContext";

type ShellContextGlobal = typeof globalThis & {
  [SHELL_CONTEXT_KEY]?: ReturnType<typeof createContext<ShellState | null>>;
};

/** Survive Vite HMR so Provider and useShell keep the same Context identity. */
const ShellContext =
  (globalThis as ShellContextGlobal)[SHELL_CONTEXT_KEY] ??
  createContext<ShellState | null>(null);
(globalThis as ShellContextGlobal)[SHELL_CONTEXT_KEY] = ShellContext;

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

  // Heal empty in-memory state when localStorage still has projects (HMR /
  // failed-load races). Runs once after mount.
  useEffect(() => {
    if (storedProjects.length > 0) return;
    const again = sortByUpdatedDesc(loadStoredProjects());
    if (again.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount heal from localStorage
    setStoredProjects(again);
    const session = loadShellSession(new Set(again.map((p) => p.id)));
    if (session.openProjectId) {
      setOpenProjectId(session.openProjectId);
      setMode(session.mode);
      setSelectedSceneId(session.selectedSceneId);
      setPrimaryTab(session.primaryTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount heal only
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
  if (!openProjectId && creationsFilterId === "inProject") {
    setCreationsFilterId("all");
  }

  /** Functional update so rapid sequential writes (e.g. activate + scrub) compose. */
  const updateStoredProjects = useCallback(
    (updater: (prev: StoredProject[]) => StoredProject[]) => {
      setStoredProjects((prev) => {
        const next = updater(prev);
        // Guard against accidental wipe from a stale empty prev after a failed load.
        if (prev.length > 0 && next.length === 0) {
          console.error(
            "[updateStoredProjects] Refusing to replace non-empty projects with []",
          );
          return prev;
        }
        const sorted = sortByUpdatedDesc(next);
        saveStoredProjects(sorted);
        return sorted;
      });
    },
    [],
  );

  // One-shot cleanup: strip ordinary group members flattened onto projects by
  // an earlier reconcile that expanded every group. Must refresh covers first —
  // detail/local rows often omit meta.group, so strip would no-op otherwise.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = loadStoredProjects();
        if (current.length === 0) return;

        const coverIds = await collectProjectGroupCoverIdsToRefresh(current);
        if (cancelled) return;
        if (coverIds.length > 0) {
          await refreshCreationsFromListById(coverIds);
        }
        if (cancelled) return;
        await syncGroupMembersManifest();
        if (cancelled) return;

        const { projects, result } =
          await reconcileStoredProjectsFromLibrary(loadStoredProjects());
        if (cancelled) return;
        if (result.projectsUpdated > 0) {
          updateStoredProjects(() => projects);
        }
        if (result.creationsRemoved > 0) {
          setChromeStatus(
            `Cleaned ${result.creationsRemoved.toLocaleString()} expanded group asset(s) from ${result.projectsUpdated.toLocaleString()} project(s)`,
          );
        }
      } catch (error) {
        console.error("Failed to clean up project group expansions", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setChromeStatus, updateStoredProjects]);

  // Keep add-asset generation able to commit results after Editor unmounts
  // (e.g. user browses Library while a job is running).
  useEffect(() => {
    bindAddAssetGenerationApplier({
      applySuccess: (result: AddAssetGenerationSuccess) => {
        updateStoredProjects((prev) =>
          prev.map((project) => {
            if (project.id !== result.projectId) return project;
            let next = mergeCreationIds(project, result.projectCreationIds);
            if (result.videosGroupId || result.imagesGroupId) {
              next = setStoredProjectGroupIds(next, {
                ...(result.videosGroupId
                  ? { videosGroupId: result.videosGroupId }
                  : {}),
                ...(result.imagesGroupId
                  ? { imagesGroupId: result.imagesGroupId }
                  : {}),
              });
            }
            const timeline = storedProjectToUi(next).timeline;
            const placeholder = timeline.find(
              (clip) => clip.id === result.clipId,
            );
            if (!placeholder) {
              return next;
            }
            const draft = placeholder.addAssetDraft;
            const addAssetGeneration = {
              prompt: result.prompt,
              audioMode:
                result.mode === "first_last" ||
                result.mode === "motion_match"
                  ? undefined
                  : result.audioMode,
              lyricsText:
                result.mode === "first_last" ||
                result.mode === "motion_match" ||
                result.audioMode === "none"
                  ? undefined
                  : result.lyricsText.trim() || undefined,
              generatedAt: new Date().toISOString(),
              creationId: result.creationId,
              mode: result.mode,
              model: result.model,
              provider: draft?.provider,
              methodId: draft?.methodId,
              startFrameAssetId: draft?.startFrameAssetId,
              startFrameFraming: draft?.startFrameFraming,
              useNearestDuration: draft?.useNearestDuration,
              replicateTweaks: draft?.replicateTweaks,
            };
            const nextTimeline = replaceAddAssetPlaceholderWithVideo(
              timeline,
              result.clipId,
              result.creationId,
              { addAssetGeneration },
            );
            // Catalog stamp so Assets-pane selection can show Generated details
            // even after the timeline clip is removed.
            void (async () => {
              try {
                const creation = await getCreation(result.creationId);
                await applyManifest([
                  creationUpsertWithAddAssetGeneration(
                    creation,
                    addAssetGeneration,
                  ),
                ]);
              } catch {
                // Clip provenance remains; catalog stamp is best-effort.
              }
            })();
            return setStoredProjectTimeline(next, nextTimeline);
          }),
        );
      },
      applyFailure: (result) => {
        updateStoredProjects((prev) =>
          prev.map((project) => {
            if (project.id !== result.projectId) return project;
            const timeline = storedProjectToUi(project).timeline;
            const nextTimeline = timeline.map((clip) => {
              if (clip.id !== result.clipId) return clip;
              const draft = { ...clip.addAssetDraft };
              const err = result.errorMessage.trim();
              if (err) draft.lastError = err;
              else delete draft.lastError;
              if (result.replicatePredictionId !== undefined) {
                if (result.replicatePredictionId?.trim()) {
                  draft.replicatePredictionId =
                    result.replicatePredictionId.trim();
                } else {
                  delete draft.replicatePredictionId;
                }
              }
              const keys = Object.keys(draft).filter(
                (k) => draft[k as keyof typeof draft] !== undefined,
              );
              return {
                ...clip,
                addAssetDraft: keys.length > 0 ? draft : undefined,
              };
            });
            return setStoredProjectTimeline(project, nextTimeline);
          }),
        );
      },
      clearFailure: (projectId, clipId) => {
        updateStoredProjects((prev) =>
          prev.map((project) => {
            if (project.id !== projectId) return project;
            const timeline = storedProjectToUi(project).timeline;
            let changed = false;
            const nextTimeline = timeline.map((clip) => {
              if (
                clip.id !== clipId ||
                (!clip.addAssetDraft?.lastError &&
                  !clip.addAssetDraft?.replicatePredictionId)
              ) {
                return clip;
              }
              changed = true;
              const rest = { ...clip.addAssetDraft };
              delete rest.lastError;
              delete rest.replicatePredictionId;
              return {
                ...clip,
                addAssetDraft: Object.keys(rest).length > 0 ? rest : undefined,
              };
            });
            return changed
              ? setStoredProjectTimeline(project, nextTimeline)
              : project;
          }),
        );
      },
    });
    return () => bindAddAssetGenerationApplier(null);
  }, [updateStoredProjects]);

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

  const project = !openProjectId
    ? emptyUiProject()
    : (() => {
        const found = storedProjects.find((p) => p.id === openProjectId);
        return found ? storedProjectToUi(found) : emptyUiProject();
      })();

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

  const reconcileProjectsAfterLibrarySync = useCallback(
    async (opts?: { refreshCoversFromList?: boolean }) => {
      const current = loadStoredProjects();
      // Newest sync may miss older group covers; list pages carry meta.group
      // (detail GET often omits it). Full catalog sync already refreshed covers.
      if (opts?.refreshCoversFromList !== false) {
        const coverIds = await collectProjectGroupCoverIdsToRefresh(current);
        if (coverIds.length > 0) {
          await refreshCreationsFromListById(coverIds);
        }
      }
      // Materialize embedded members as catalog rows.
      await syncGroupMembersManifest();
      const { projects, result } =
        await reconcileStoredProjectsFromLibrary(current);
      if (result.projectsUpdated > 0) {
        updateStoredProjects(() => projects);
      }
      return result;
    },
    [updateStoredProjects],
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
    (folderIds: string[], memberCreationIds: string[] = []) => {
      if (folderIds.length === 0 && memberCreationIds.length === 0) return;
      patchOpenProject((p) =>
        removeFolderIds(p, folderIds, memberCreationIds),
      );
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

  const setOpenProjectLookEnabled = useCallback(
    (lookId: ProjectLookId, enabled: boolean) => {
      patchOpenProject((p) => setStoredProjectLookEnabled(p, lookId, enabled));
    },
    [patchOpenProject],
  );

  const setOpenProjectTimeline = useCallback(
    (
      timeline:
        | TimelineClip[]
        | ((prev: TimelineClip[]) => TimelineClip[]),
    ) => {
      patchOpenProject((p) => {
        const prev = storedProjectToUi(p).timeline;
        const next = typeof timeline === "function" ? timeline(prev) : timeline;
        return setStoredProjectTimeline(p, next);
      });
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

  const selectCreationsOnOpenProject = useCallback(
    (creationIds: string[], primaryId: string | null) => {
      patchOpenProject((p) => {
        const merged =
          creationIds.length > 0 ? mergeCreationIds(p, creationIds) : p;
        return setStoredProjectSelectedAssetId(merged, primaryId);
      });
    },
    [patchOpenProject],
  );

  const setOpenProjectPendingStagedDraft = useCallback(
    (draft: unknown | null) => {
      patchOpenProject((p) => setStoredProjectPendingStagedDraft(p, draft));
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

  const setOpenProjectGroupIds = useCallback(
    (ids: {
      imagesGroupId?: string | null;
      videosGroupId?: string | null;
    }) => {
      patchOpenProject((p) => setStoredProjectGroupIds(p, ids));
    },
    [patchOpenProject],
  );

  const setOpenProjectLabPrompts = useCallback(
    (prompts: {
      labStillPrompt?: string | null;
      labAnimatePrompt?: string | null;
    }) => {
      patchOpenProject((p) => setStoredProjectLabPrompts(p, prompts));
    },
    [patchOpenProject],
  );

  const setOpenProjectMainAudioCreationId = useCallback(
    (creationId: string | null) => {
      patchOpenProject((p) => setStoredProjectMainAudioCreationId(p, creationId));
    },
    [patchOpenProject],
  );

  const setOpenProjectLyricAlignment = useCallback(
    (alignment: LyricAlignment | null) => {
      patchOpenProject((p) => setStoredProjectLyricAlignment(p, alignment));
    },
    [patchOpenProject],
  );

  const setOpenProjectStoryboardProposal = useCallback(
    (proposal: StoryboardProposal | null) => {
      patchOpenProject((p) => setStoredProjectStoryboardProposal(p, proposal));
    },
    [patchOpenProject],
  );

  const patchOpenProjectStoryboardGenerationPlan = useCallback(
    (
      mutate: (
        plan: StoryboardGenerationPlan | undefined,
        proposal: StoryboardProposal,
      ) => StoryboardGenerationPlan,
    ) => {
      patchOpenProject((p) =>
        patchStoredProjectStoryboardGenerationPlan(p, mutate),
      );
    },
    [patchOpenProject],
  );

  const setOpenProjectLabStoryboardDirection = useCallback(
    (direction: string | null) => {
      patchOpenProject((p) => setStoredProjectLabStoryboardDirection(p, direction));
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
      setOpenProjectLookEnabled,
      setOpenProjectTimeline,
      setOpenProjectSelectedTimelineClipId,
      setOpenProjectSelectedAssetId,
      selectCreationsOnOpenProject,
      setOpenProjectPendingStagedDraft,
      setOpenProjectTimelineZoom,
      setOpenProjectTimelineMonitorActive,
      setOpenProjectTimelinePlayheadSec,
      setOpenProjectGroupIds,
      setOpenProjectLabPrompts,
      setOpenProjectMainAudioCreationId,
      setOpenProjectLyricAlignment,
      setOpenProjectStoryboardProposal,
      patchOpenProjectStoryboardGenerationPlan,
      setOpenProjectLabStoryboardDirection,
      addCreationsToOpenProject,
      reconcileProjectsAfterLibrarySync,
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
      setOpenProjectLookEnabled,
      setOpenProjectTimeline,
      setOpenProjectSelectedTimelineClipId,
      setOpenProjectSelectedAssetId,
      selectCreationsOnOpenProject,
      setOpenProjectPendingStagedDraft,
      setOpenProjectTimelineZoom,
      setOpenProjectTimelineMonitorActive,
      setOpenProjectTimelinePlayheadSec,
      setOpenProjectGroupIds,
      setOpenProjectLabPrompts,
      setOpenProjectMainAudioCreationId,
      setOpenProjectLyricAlignment,
      setOpenProjectStoryboardProposal,
      patchOpenProjectStoryboardGenerationPlan,
      setOpenProjectLabStoryboardDirection,
      addCreationsToOpenProject,
      reconcileProjectsAfterLibrarySync,
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
      setChromeStatus,
    ],
  );

  return (
    <ShellContext.Provider value={value}>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ShellContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useShell(): ShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within ShellProvider");
  return ctx;
}

/** Soft read for decorative UI that should not crash during HMR remounts. */
// eslint-disable-next-line react-refresh/only-export-components
export function useShellOptional(): ShellState | null {
  return useContext(ShellContext);
}
