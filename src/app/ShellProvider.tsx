import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  loadStoredProjectsStrict,
  mergeCreationIds,
  renameStoredProject,
  replaceStoredProjectAssets,
  setStoredProjectAspectRatio,
  upsertStoredStillWorkstream,
  removeStoredStillWorkstream,
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
import { collectProjectReferencedCreationIds } from "../project/projectUsage";
import {
  addProjectAssets,
  reconcileLegacyProjectFolder,
  removeProjectAssetsChecked,
  renameProjectFolder,
  provisionProjectFolder,
  type ProjectFolderReconcileResult,
} from "../project/projectFolderClient";
import {
  initializeProjectUsageIndexes,
  mirrorStoredProjectsAfterNativeMembership,
  mutateStoredProjects,
  mutateStoredProjectsWithNativeMutation,
} from "../project/projectMutationCoordinator";
import { listFolders, type LibraryFolder } from "../library/folderClient";
import { listen } from "@tauri-apps/api/event";
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
import {
  applyManifest,
  deleteCreationChecked,
  getCreation,
} from "../library/catalogClient";
import { creationUpsertWithAddAssetGeneration } from "../project/desktopAddAssetGeneration";
import {
  loadShellSession,
  saveShellSession,
  type LibrarySurface,
  type PrimaryTab,
} from "./shellSession";
import type { FilterId } from "../library/creationFilters";
import {
  syncLibraryFolders,
  type FolderConflict,
  type FolderSyncResult,
} from "../sync/folderSync";

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
  openProject: (id: string) => Promise<void>;
  closeProject: () => void;
  /** Create a project (optionally from library creation IDs) and open it. */
  createProject: (title: string, creationIds?: string[]) => Promise<string | null>;
  /** Rename the open project (no-op if none open). */
  renameOpenProject: (title: string) => Promise<void>;
  /** Rename any locally available project and its canonical folder. */
  renameProject: (projectId: string, title: string) => Promise<void>;
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
  addCreationsToOpenProject: (creationIds: string[]) => Promise<void>;
  /** Add Library creations to any locally available project. */
  addCreationsToProject: (
    projectId: string,
    creationIds: string[],
  ) => Promise<boolean>;
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
  removeCreationsFromOpenProject: (creationIds: string[]) => Promise<void>;
  /** Remove unused creations from any locally available project. */
  removeCreationsFromProject: (
    projectId: string,
    creationIds: string[],
  ) => Promise<void>;
  /** Globally delete after a strict all-project audit. */
  deleteLibraryCreation: (creationId: string) => Promise<void>;
  /** Sync cloud folders while project saves/removals are serialized. */
  syncProjectFolders: (opts?: {
    resolutions?: Record<string, "local" | "cloud">;
    priorConflicts?: FolderConflict[];
  }) => Promise<FolderSyncResult>;
  /** Create or replace a still workstream on the open project. */
  upsertOpenStillWorkstream: (
    stream: import("../project/stillWorkstream").StillWorkstream,
  ) => Promise<void>;
  /** Remove a still composition from the open project. */
  removeOpenStillWorkstream: (workstreamId: string) => Promise<void>;
  /** Last Creations filter — survives Library ↔ Project switches. */
  creationsFilterId: FilterId;
  setCreationsFilterId: (id: FilterId) => void;
  /** Quiet status for the app header (e.g. "Showing 40 of 200"). */
  chromeStatus: string | null;
  setChromeStatus: (status: string | null) => void;
  project: Project;
  recentProjects: {
    id: string;
    title: string;
    lifecycle: StoredProject["lifecycle"];
  }[];
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

function mirrorProjectFolderMembership(
  projects: StoredProject[],
  folders: readonly LibraryFolder[],
): StoredProject[] {
  const projectFolders = new Map(
    folders
      .filter((folder) => folder.kind === "project" && folder.projectId)
      .map((folder) => [folder.projectId as string, folder]),
  );
  return projects.map((project) => {
    const folder = projectFolders.get(project.id);
    return folder ? replaceStoredProjectAssets(project, folder.memberIds) : project;
  });
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [storedProjects, setStoredProjects] = useState<StoredProject[]>(() =>
    sortByUpdatedDesc(loadStoredProjects()),
  );
  const [projectFolderBlock, setProjectFolderBlock] =
    useState<ProjectFolderReconcileResult | null>(null);
  const [blockedProjectTitle, setBlockedProjectTitle] = useState("");
  const [projectOpenWarning, setProjectOpenWarning] = useState<string | null>(
    null,
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
    null,
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

  const publishStoredProjects = useCallback((projects: StoredProject[]) => {
    const sorted = sortByUpdatedDesc(projects);
    setStoredProjects(sorted);
    return sorted;
  }, []);

  /** Functional update so rapid sequential writes (e.g. activate + scrub) compose. */
  const updateStoredProjects = useCallback(
    (updater: (prev: StoredProject[]) => StoredProject[]) => {
      return mutateStoredProjects((prev) => {
        const next = updater(prev);
        if (prev.length > 0 && next.length === 0) {
          throw new Error("Refusing to replace non-empty projects with []");
        }
        return sortByUpdatedDesc(next);
      }).then(publishStoredProjects);
    },
    [publishStoredProjects],
  );

  useEffect(() => {
    void (async () => {
      try {
        await initializeProjectUsageIndexes(loadStoredProjectsStrict());
      } catch (error) {
        console.error("Failed to initialize project usage protection", error);
        setChromeStatusState("Project usage protection needs repair");
      }
    })();
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<LibraryFolder[]>("library-folders-updated", (event) => {
      void mirrorStoredProjectsAfterNativeMembership((projects) =>
        mirrorProjectFolderMembership(projects, event.payload),
      ).then(publishStoredProjects).catch((error) => {
        console.error("Failed to mirror project-folder membership", error);
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [publishStoredProjects]);

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
          await updateStoredProjects(() => projects);
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
      applySuccess: async (result: AddAssetGenerationSuccess) => {
        await updateStoredProjects((prev) =>
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
        void updateStoredProjects((prev) =>
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
        ).catch((error) => {
          console.error("Failed to save generation error", error);
        });
      },
      clearFailure: (projectId, clipId) => {
        void updateStoredProjects((prev) =>
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
        ).catch((error) => {
          console.error("Failed to clear generation error", error);
        });
      },
    });
    return () => bindAddAssetGenerationApplier(null);
  }, [updateStoredProjects]);

  const patchOpenProject = useCallback(
    (patch: (project: StoredProject) => StoredProject) => {
      if (!openProjectId) return;
      const id = openProjectId;
      void updateStoredProjects((prev) =>
        prev.map((p) => (p.id === id ? patch(p) : p)),
      ).catch((error) => {
        console.error("Failed to save project", error);
        window.alert(error instanceof Error ? error.message : String(error));
      });
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
    () =>
      storedProjects.map((p) => ({
        id: p.id,
        title: p.title,
        lifecycle: p.lifecycle,
      })),
    [storedProjects],
  );

  const toggleLeft = useCallback(() => setLeftCollapsed((v) => !v), []);
  const toggleRight = useCallback(() => setRightCollapsed((v) => !v), []);

  const reconcileProjectForOpen = useCallback(
    async (projectToOpen: StoredProject): Promise<StoredProject | null> => {
      const { result, projects } =
        await mutateStoredProjectsWithNativeMutation(
          async (current) => {
            const project = current.find(
              (candidate) => candidate.id === projectToOpen.id,
            );
            if (!project) throw new Error("Project no longer exists");
            const folders = await listFolders();
            const attached = new Set(project.folderIds ?? []);
            const attachedMemberIds = folders
              .filter((folder) => attached.has(folder.id))
              .flatMap((folder) => folder.memberIds);
            const usedIds = new Set(collectProjectReferencedCreationIds(project));
            const folderByMember = new Map<string, LibraryFolder>();
            for (const folder of folders) {
              for (const creationId of folder.memberIds) {
                folderByMember.set(creationId, folder);
              }
            }
            const folderCounts = new Map<string, number>();
            for (const creationId of project.creationIds) {
              const folder = folderByMember.get(creationId);
              if (folder) {
                folderCounts.set(
                  folder.id,
                  (folderCounts.get(folder.id) ?? 0) + 1,
                );
              }
            }
            const rankedFolders = [...folderCounts.entries()].sort(
              (a, b) => b[1] - a[1],
            );
            const dominantFolderId =
              rankedFolders.length > 0 &&
              (rankedFolders.length === 1 ||
                rankedFolders[0][1] > rankedFolders[1][1])
                ? rankedFolders[0][0]
                : null;
            // A legacy project can contain stale pool entries copied from an
            // unrelated folder. Drop only un-used outliers when there is a
            // clear candidate folder; timeline/composition references remain
            // blockers and are never silently discarded.
            const projectCreationIds = project.creationIds.filter((creationId) => {
              const folder = folderByMember.get(creationId);
              return (
                !dominantFolderId ||
                !folder ||
                folder.id === dominantFolderId ||
                usedIds.has(creationId)
              );
            });
            const legacyAssetIds = [
              ...new Set([
                ...projectCreationIds,
                ...attachedMemberIds,
                ...collectProjectReferencedCreationIds(project),
              ]),
            ];
            return reconcileLegacyProjectFolder({
              projectId: project.id,
              title: project.title,
              boundFolderIds: project.boundFolderId
                ? [project.boundFolderId]
                : [],
              legacyAssetIds,
            });
          },
          (current, reconcileResult) =>
            reconcileResult.status === "ready" && reconcileResult.folder
              ? current.map((project) =>
                  project.id === projectToOpen.id
                    ? {
                        ...replaceStoredProjectAssets(
                          project,
                          reconcileResult.folder?.memberIds ?? [],
                        ),
                        folderIds: [],
                        boundFolderId: null,
                        lifecycle: "ready" as const,
                      }
                    : project,
                )
              : current,
        );
      if (result.status === "blocked" || !result.folder) {
        setBlockedProjectTitle(projectToOpen.title);
        setProjectFolderBlock(result);
        return null;
      }
      const usedIds = new Set(collectProjectReferencedCreationIds(projectToOpen));
      const missingUsedIds = result.missingCreationIds.filter((id) =>
        usedIds.has(id),
      );
      if (missingUsedIds.length > 0) {
        setProjectOpenWarning(
          `${projectToOpen.title} contains ${missingUsedIds.length} Library file(s) still referenced by project content but no longer available. The project will open, but affected clips or compositions may be unavailable. Missing IDs: ${missingUsedIds.join(", ")}`,
        );
      }
      const sorted = publishStoredProjects(projects);
      return sorted.find((project) => project.id === projectToOpen.id) ?? null;
    },
    [publishStoredProjects, setProjectOpenWarning],
  );

  const openProject = useCallback(
    async (id: string, focus = true) => {
      setProjectOpenWarning(null);
      let found: StoredProject | undefined;
      try {
        found = loadStoredProjectsStrict().find((p) => p.id === id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Failed to read project", error);
        setChromeStatus(`Cannot open project: ${message}`);
        window.alert(message);
        return;
      }
      if (!found) {
        const message = "That project is no longer available on this device.";
        setChromeStatus(message);
        window.alert(message);
        return;
      }
      let ready: StoredProject | null = null;
      if (
        found.lifecycle === "provisioning" ||
        found.lifecycle === "repair-needed"
      ) {
        try {
          const { result, projects } =
            await mutateStoredProjectsWithNativeMutation(
              async () => {
                const provisioned = await provisionProjectFolder(
                  found.id,
                  found.title,
                  found.creationIds,
                );
                return { provisioned, folders: await listFolders() };
              },
              (current, payload) =>
                mirrorProjectFolderMembership(
                  current.map((project) =>
                    project.id === found.id
                      ? {
                          ...project,
                          folderIds: [],
                          boundFolderId: null,
                          lifecycle: "ready" as const,
                        }
                      : project,
                  ),
                  payload.folders,
                ),
            );
          const next = publishStoredProjects(projects);
          ready = next.find((project) => project.id === found.id) ?? null;
          if (result.provisioned.missingCreationIds.length > 0) {
            window.alert(
              `Project repaired without ${result.provisioned.missingCreationIds.length} file(s) that no longer exist in Library:\n${result.provisioned.missingCreationIds.join(", ")}`,
            );
          }
        } catch (error) {
          console.error("Failed to retry project folder setup", error);
          window.alert(error instanceof Error ? error.message : String(error));
          return;
        }
      } else {
        ready = await reconcileProjectForOpen(found).catch((error) => {
          console.error("Failed to prepare project folder", error);
          window.alert(error instanceof Error ? error.message : String(error));
          return null;
        });
      }
      if (!ready) return;
      setOpenProjectId(id);
      if (focus) {
        setPrimaryTab("project");
        setMode("director");
        setSelectedSceneId(`${id}-scene-1`);
      }
    },
    [publishStoredProjects, reconcileProjectForOpen, setChromeStatus],
  );

  const startupOpenAttempted = useRef(false);
  useEffect(() => {
    if (startupOpenAttempted.current) return;
    startupOpenAttempted.current = true;
    if (!initialSession.openProjectId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring the persisted session is the purpose of this mount effect
    void openProject(initialSession.openProjectId, false);
  }, [initialSession.openProjectId, openProject]);

  const closeProject = useCallback(() => {
    setOpenProjectId(null);
    setSelectedSceneId(null);
    setPrimaryTab("project");
  }, []);

  const createProject = useCallback(
    async (title: string, creationIds: string[] = []) => {
      // Persist the provisioning document first; native creates the project
      // root and files the complete selection in one checked transaction.
      // Selection is not owned until the native provisioning transaction
      // succeeds. Persisting an empty provisioning document also lets native
      // return a structured warning for selections that disappeared meanwhile.
      const created = createStoredProject(title, []);
      await updateStoredProjects((prev) => [
        created,
        ...prev.filter((p) => p.id !== created.id),
      ]);
      try {
        const { result, projects } =
          await mutateStoredProjectsWithNativeMutation(
            async () => {
              const provisioned = await provisionProjectFolder(
                created.id,
                created.title,
                creationIds,
              );
              return { provisioned, folders: await listFolders() };
            },
            (current, payload) =>
              mirrorProjectFolderMembership(
                current.map((project) =>
                  project.id === created.id
                    ? {
                        ...project,
                        folderIds: [],
                        boundFolderId: null,
                        lifecycle: "ready" as const,
                      }
                    : project,
                ),
                payload.folders,
              ),
          );
        publishStoredProjects(projects);
        if (result.provisioned.missingCreationIds.length > 0) {
          window.alert(
            `Project created without ${result.provisioned.missingCreationIds.length} file(s) that no longer exist in Library:\n${result.provisioned.missingCreationIds.join(", ")}`,
          );
        }
      } catch (error) {
        await updateStoredProjects((projects) =>
          projects.map((project) =>
            project.id === created.id
              ? { ...project, lifecycle: "repair-needed" as const }
              : project,
          ),
        );
        window.alert(error instanceof Error ? error.message : String(error));
        return null;
      }
      setOpenProjectId(created.id);
      setPrimaryTab("project");
      setMode("director");
      setSelectedSceneId(`${created.id}-scene-1`);
      return created.id;
    },
    [publishStoredProjects, updateStoredProjects],
  );

  const addCreationsToProject = useCallback(
    async (projectId: string, creationIds: string[]) => {
      if (creationIds.length === 0) return false;
      const perform = async (allowCrossProjectMove: boolean) => {
        const { projects } = await mutateStoredProjectsWithNativeMutation(
          async () => {
            const result = await addProjectAssets(
              projectId,
              creationIds,
              allowCrossProjectMove,
            );
            return { result, folders: await listFolders() };
          },
          (current, payload) =>
            mirrorProjectFolderMembership(current, payload.folders),
        );
        publishStoredProjects(projects);
      };
      try {
        await perform(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Confirm moving it to this project/i.test(message)) throw error;
        const confirmed = window.confirm(
          `${message}\n\nMove the unused file to this project?`,
        );
        if (!confirmed) return false;
        await perform(true);
      }
      return true;
    },
    [publishStoredProjects],
  );

  const addCreationsToOpenProject = useCallback(
    async (creationIds: string[]) => {
      if (!openProjectId) return;
      await addCreationsToProject(openProjectId, creationIds);
    },
    [addCreationsToProject, openProjectId],
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
        await updateStoredProjects(() => projects);
      }
      return result;
    },
    [updateStoredProjects],
  );

  const removeCreationsFromProject = useCallback(
    async (projectId: string, creationIds: string[]) => {
      if (creationIds.length === 0) return;
      const { projects } = await mutateStoredProjectsWithNativeMutation(
        async () => {
          const result = await removeProjectAssetsChecked(projectId, creationIds);
          return { result, folders: await listFolders() };
        },
        (current, payload) =>
          mirrorProjectFolderMembership(current, payload.folders),
      );
      publishStoredProjects(projects);
    },
    [publishStoredProjects],
  );

  const removeCreationsFromOpenProject = useCallback(
    async (creationIds: string[]) => {
      if (!openProjectId) return;
      await removeCreationsFromProject(openProjectId, creationIds);
    },
    [openProjectId, removeCreationsFromProject],
  );

  const deleteLibraryCreation = useCallback(
    async (creationId: string) => {
      const { projects } = await mutateStoredProjectsWithNativeMutation(
        (current) =>
          deleteCreationChecked(
            creationId,
            current.map((project) => project.id),
          ),
        (current) =>
          current.map((project) =>
            project.creationIds.includes(creationId)
              ? replaceStoredProjectAssets(
                  project,
                  project.creationIds.filter((id) => id !== creationId),
                )
              : project,
          ),
      );
      publishStoredProjects(projects);
    },
    [publishStoredProjects],
  );

  const syncProjectFolders = useCallback(
    async (opts?: {
      resolutions?: Record<string, "local" | "cloud">;
      priorConflicts?: FolderConflict[];
    }) => {
      const { result, projects } =
        await mutateStoredProjectsWithNativeMutation(
          async () => {
            const folderResult = await syncLibraryFolders(opts);
            return { folderResult, folders: await listFolders() };
          },
          (current, payload) =>
            mirrorProjectFolderMembership(current, payload.folders),
          { allowMissingCreationIds: true },
        );
      publishStoredProjects(projects);
      return result.folderResult;
    },
    [publishStoredProjects],
  );

  const upsertOpenStillWorkstream = useCallback(
    async (stream: import("../project/stillWorkstream").StillWorkstream) => {
      if (!openProjectId) return;
      await updateStoredProjects((projects) =>
        projects.map((project) =>
          project.id === openProjectId
            ? upsertStoredStillWorkstream(project, stream)
            : project,
        ),
      );
    },
    [openProjectId, updateStoredProjects],
  );

  const removeOpenStillWorkstream = useCallback(
    async (workstreamId: string) => {
      if (!openProjectId) return;
      await updateStoredProjects((projects) =>
        projects.map((project) =>
          project.id === openProjectId
            ? removeStoredStillWorkstream(project, workstreamId)
            : project,
        ),
      );
    },
    [openProjectId, updateStoredProjects],
  );

  const renameProject = useCallback(
    async (projectId: string, title: string) => {
      const next = await updateStoredProjects((projects) =>
        projects.map((project) =>
          project.id === projectId
            ? renameStoredProject(project, title)
            : project,
        ),
      );
      const renamed = next.find((project) => project.id === projectId);
      if (!renamed) return;
      try {
        await renameProjectFolder(projectId, renamed.title);
      } catch (error) {
        await updateStoredProjects((projects) =>
          projects.map((project) =>
            project.id === projectId
              ? { ...project, lifecycle: "repair-needed" as const }
              : project,
          ),
        );
        throw error;
      }
    },
    [updateStoredProjects],
  );

  const renameOpenProject = useCallback(
    async (title: string) => {
      if (!openProjectId) return;
      await renameProject(openProjectId, title);
    },
    [openProjectId, renameProject],
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
      renameProject,
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
      addCreationsToProject,
      reconcileProjectsAfterLibrarySync,
      removeCreationsFromOpenProject,
      removeCreationsFromProject,
      deleteLibraryCreation,
      syncProjectFolders,
      upsertOpenStillWorkstream,
      removeOpenStillWorkstream,
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
      renameProject,
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
      addCreationsToProject,
      reconcileProjectsAfterLibrarySync,
      removeCreationsFromOpenProject,
      removeCreationsFromProject,
      deleteLibraryCreation,
      syncProjectFolders,
      upsertOpenStillWorkstream,
      removeOpenStillWorkstream,
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
      <ConfirmProvider>
        {children}
        {projectFolderBlock ? (
          <div className="confirm-dialog-backdrop" role="presentation">
            <div
              className="confirm-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="project-folder-block-title"
            >
              <h2 id="project-folder-block-title">
                Project folder needed
              </h2>
              <p>
                <strong>{blockedProjectTitle}</strong> could not be assigned a
                project folder safely.
              </p>
              {projectFolderBlock.bindingProblem ? (
                <p>{projectFolderBlock.bindingProblem}</p>
              ) : null}
              {projectFolderBlock.blockers.map((group) => (
                <div key={group.folderId ?? "root"}>
                  <p>
                    <strong>{group.folderTitle}</strong>
                    {group.projectId
                      ? ` — owned by project ${group.projectId}`
                      : ""}
                  </p>
                  <p className="muted">{group.creationIds.join(", ")}</p>
                </div>
              ))}
              {projectFolderBlock.missingCreationIds.length > 0 ? (
                <div>
                  <p>
                    <strong>Missing creations</strong>
                  </p>
                  <p className="muted">
                    {projectFolderBlock.missingCreationIds.join(", ")}
                  </p>
                </div>
              ) : null}
              <p className="muted">
                In Library, put every available project file in one regular
                folder, or move all of them to Library root, then reopen the
                project. A file owned by another project must first be removed
                safely from that project. Missing IDs must be restored with the
                same ID; importing a replacement creates a different file.
              </p>
              <div className="confirm-dialog-actions">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setProjectFolderBlock(null)}
                >
                  Close
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setProjectFolderBlock(null);
                    setPrimaryTab("library");
                    setLibrarySurface("creations");
                  }}
                >
                  Open Library
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {projectOpenWarning ? (
          <div className="confirm-dialog-backdrop" role="presentation">
            <div
              className="confirm-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="project-open-warning-title"
            >
              <h2 id="project-open-warning-title">Project opened with missing files</h2>
              <p>{projectOpenWarning}</p>
              <div className="confirm-dialog-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setProjectOpenWarning(null)}
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </ConfirmProvider>
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
