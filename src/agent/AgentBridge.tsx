import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { useAuthOptional } from "../auth/AuthProvider";
import { useShellOptional } from "../app/ShellProvider";
import {
  cacheMissingMedia,
  cacheMissingThumbs,
  clearSyncedLocal,
  deleteLocal,
  getCreation,
  getSyncStatus,
} from "../library/catalogClient";
import {
  groupSourceCreationIds,
  isGroupCreation,
} from "../library/creationFlags";
import { createFolder, deleteFolder, removeFromFolder } from "../library/folderClient";
import type { SyncStatus } from "../library/types";
import { requestOpenNewAsset } from "../layouts/editor/addAssetEvents";
import { parasceneResolveStillModel } from "../layouts/editor/parasceneProductCaps";
import type { LayoutMode } from "../app/shellSession";
import { getProjectFolder } from "../project/projectFolderClient";
import { runLabParasceneGenerate } from "../services/labParasceneGenerate";
import {
  deleteCreationViaService,
  ungroupCreationsViaService,
} from "../services/parasceneCatalog";
import { runSyncNewest } from "../services/syncCatalog";

type AgentRequest = {
  id: string;
  action: string;
  args?: Record<string, unknown>;
};

function argString(args: Record<string, unknown> | undefined, key: string): string {
  const raw = args?.[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function showLibrary(
  shell: ReturnType<typeof useShellOptional>,
  surface: "creations" | "sync",
) {
  if (!shell) return;
  shell.setPrimaryTab("library");
  shell.setLibrarySurface(surface);
}

function showProject(
  shell: ReturnType<typeof useShellOptional>,
  mode?: LayoutMode,
) {
  if (!shell) return;
  shell.setPrimaryTab("project");
  if (mode) shell.setMode(mode);
}

const SHELL_TABS = new Set(["library", "project"]);
const LIBRARY_SURFACES = new Set(["creations", "sync"]);
const PROJECT_MODES = new Set(["director", "editor", "hook", "lab"]);

function parseProjectMode(raw: string): LayoutMode | null {
  return PROJECT_MODES.has(raw) ? (raw as LayoutMode) : null;
}

function collectDeleteIds(
  args: Record<string, unknown> | undefined,
): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      out.push(String(value));
      return;
    }
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  };
  add(args?.id);
  add(args?.creationId);
  add(args?.imagesGroupId);
  if (Array.isArray(args?.ids)) {
    for (const value of args.ids) add(value);
  }
  return [...new Set(out)];
}

/** Hold after each action so a person can see the UI settle before the next step. */
function watchHoldMs(action: string): number {
  switch (action) {
    case "library.clearLocal":
      return 2800;
    case "generation.start":
      return 3200;
    case "cloud.delete":
    case "project.create":
    case "project.delete":
    case "folder.create":
    case "sync.start":
    case "sync.folders":
      return 2200;
    case "library.lookup":
      return 0;
    case "shell.show":
      return 800;
    default:
      return 1800;
  }
}

async function catalogRow(id: string) {
  try {
    return await getCreation(id);
  } catch {
    return null;
  }
}

async function expandDeleteIds(ids: string[]): Promise<string[]> {
  const out = new Set(ids);
  for (const id of ids) {
    const row = await catalogRow(id);
    if (!row || !isGroupCreation(row)) continue;
    for (const memberId of groupSourceCreationIds(row)) out.add(memberId);
  }
  return [...out];
}

async function dropLocalRow(
  id: string,
  shell: ReturnType<typeof useShellOptional>,
): Promise<void> {
  if (shell?.deleteLibraryCreation) {
    try {
      await shell.deleteLibraryCreation(id);
      return;
    } catch {
      /* fall through to unfile + deleteLocal */
    }
  }
  try {
    await removeFromFolder([id]);
  } catch {
    /* already unfiled */
  }
  await deleteLocal(id);
}

async function purgeCreations(
  ids: string[],
  shell: ReturnType<typeof useShellOptional>,
): Promise<{ ids: string[]; deleted: true }> {
  const queued = new Set(await expandDeleteIds(ids));

  if (shell?.openProjectId) {
    const imagesGroupId = shell.project?.imagesGroupId ?? null;
    const videosGroupId = shell.project?.videosGroupId ?? null;
    if (
      (imagesGroupId && queued.has(imagesGroupId)) ||
      (videosGroupId && queued.has(videosGroupId))
    ) {
      shell.setOpenProjectGroupIds({
        ...(imagesGroupId && queued.has(imagesGroupId)
          ? { imagesGroupId: null }
          : {}),
        ...(videosGroupId && queued.has(videosGroupId)
          ? { videosGroupId: null }
          : {}),
      });
    }
    try {
      await shell.removeCreationsFromProject(shell.openProjectId, [...queued]);
    } catch {
      /* may not be filed in the open project */
    }
  }
  try {
    await removeFromFolder([...queued]);
  } catch {
    /* unfile is required before local delete; retry per id below */
  }

  for (const id of [...queued]) {
    const row = await catalogRow(id);
    if (!row || !isGroupCreation(row)) continue;
    try {
      const { restoredCreationIds } = await ungroupCreationsViaService(id);
      for (const memberId of restoredCreationIds) queued.add(memberId);
    } catch {
      /* already a standalone row, or already gone on the server */
    }
  }

  const ordered = [...queued];
  for (const id of ordered) {
    await deleteCreationViaService(id);
    try {
      await dropLocalRow(id, shell);
    } catch {
      /* verify / retry below */
    }
  }

  let remaining = (
    await Promise.all(ordered.map(async (id) => ((await catalogRow(id)) ? id : "")))
  ).filter(Boolean);
  if (remaining.length > 0) {
    await sleep(600);
    for (const id of remaining) {
      await deleteCreationViaService(id).catch(() => {});
      await dropLocalRow(id, shell).catch(() => {});
    }
    remaining = (
      await Promise.all(
        remaining.map(async (id) => ((await catalogRow(id)) ? id : "")),
      )
    ).filter(Boolean);
  }
  if (remaining.length > 0) {
    throw new Error(`cloud.delete left catalog rows: ${remaining.join(", ")}`);
  }
  return { ids: ordered, deleted: true };
}

const DEFAULT_STILL_MODEL = "checkpoints/1.5/lofi_V2pre.safetensors";
const DEFAULT_STILL_PROMPT =
  "a beautiful frog in a princess dress with a tiny, little crown";

function stillRoute(modelId?: string) {
  const wanted = modelId?.trim() || DEFAULT_STILL_MODEL;
  return (
    parasceneResolveStillModel("text_to_image", wanted) ??
    parasceneResolveStillModel("text_to_image", DEFAULT_STILL_MODEL)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function waitForCache(
  kind: "thumbs" | "media",
  timeoutMs: number,
): Promise<SyncStatus> {
  const started = Date.now();
  let lastMissing = Number.POSITIVE_INFINITY;
  let changedAt = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await getSyncStatus();
    const missing =
      kind === "thumbs"
        ? status.missingThumbCacheable
        : status.missingMediaCacheable;
    const have = kind === "thumbs" ? status.withThumb : status.withMedia;
    if (missing === 0) return status;
    if (missing < lastMissing) {
      lastMissing = missing;
      changedAt = Date.now();
    } else if (have > 0 && Date.now() - changedAt > 15_000) {
      return status;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${kind} to cache`);
}

export function AgentBridge() {
  const auth = useAuthOptional();
  const shell = useShellOptional();

  useEffect(() => {
    const state = {
      auth: {
        status: auth?.status ?? "unknown",
        userId: auth?.session?.user?.sub ?? null,
      },
      shell: shell
        ? {
            primaryTab: shell.primaryTab,
            librarySurface: shell.librarySurface,
            mode: shell.mode,
            openProjectId: shell.openProjectId,
            openProjectTitle: shell.project?.title ?? null,
          }
        : null,
      projects: (shell?.recentProjects ?? []).map((p) => ({
        id: p.id,
        title: p.title,
      })),
    };
    void invoke("agent_report_ui_state", { state }).catch(() => {});
  }, [
    auth?.session?.user?.sub,
    auth?.status,
    shell,
    shell?.librarySurface,
    shell?.mode,
    shell?.openProjectId,
    shell?.primaryTab,
    shell?.project?.title,
    shell?.recentProjects,
  ]);

  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<AgentRequest>("parascene:agent-request", async (event) => {
      if (cancelled) return;
      const { id, action, args } = event.payload ?? { id: "", action: "" };
      try {
        const result = await runAction(action, args, { auth, shell });
        await sleep(watchHoldMs(action));
        await invoke("agent_complete", { id, ok: true, result, error: null });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await invoke("agent_complete", { id, ok: false, result: null, error });
      }
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, [auth, shell]);

  return null;
}

async function runAction(
  action: string,
  args: Record<string, unknown> | undefined,
  ctx: {
    auth: ReturnType<typeof useAuthOptional>;
    shell: ReturnType<typeof useShellOptional>;
  },
): Promise<unknown> {
  if (ctx.auth?.status !== "connected") {
    throw new Error("Not signed in");
  }
  switch (action) {
    case "project.create": {
      if (!ctx.shell) throw new Error("Shell is not mounted");
      showProject(ctx.shell, "director");
      const title = argString(args, "title") || "Untitled project";
      const id = await ctx.shell.createProject(title);
      if (!id) throw new Error("Create project returned no id");
      const folder = await getProjectFolder(id).catch(() => null);
      return {
        projectId: id,
        title,
        folderId: folder?.id ?? null,
        folderTitle: folder?.title ?? null,
        folderKind: folder?.kind ?? null,
      };
    }
    case "project.open": {
      if (!ctx.shell) throw new Error("Shell is not mounted");
      const mode = parseProjectMode(argString(args, "mode")) ?? "director";
      const id = argString(args, "id") || argString(args, "projectId");
      if (!id) throw new Error("project.open requires id");
      const ok = await ctx.shell.openProject(id, true);
      if (!ok) throw new Error("Could not open project");
      // openProject(focus) always lands Director; apply the requested mode after.
      showProject(ctx.shell, mode);
      return { projectId: id, mode };
    }
    case "shell.show": {
      if (!ctx.shell) throw new Error("Shell is not mounted");
      const tabRaw = argString(args, "tab");
      const surfaceRaw = argString(args, "surface");
      const modeRaw = argString(args, "mode");
      const panel = argString(args, "panel");
      const surface = LIBRARY_SURFACES.has(surfaceRaw)
        ? (surfaceRaw as "creations" | "sync")
        : null;
      const mode = parseProjectMode(modeRaw);
      let tab = SHELL_TABS.has(tabRaw) ? tabRaw : "";
      if (!tab) {
        if (surface) tab = "library";
        else if (mode || panel === "newAsset") tab = "project";
        else throw new Error("shell.show requires tab, surface, or mode");
      }
      if (tab === "library") {
        showLibrary(ctx.shell, surface ?? "creations");
      } else {
        const nextMode = mode ?? (panel === "newAsset" ? "editor" : undefined);
        if (
          (nextMode === "editor" ||
            nextMode === "hook" ||
            nextMode === "lab") &&
          !ctx.shell.openProjectId
        ) {
          throw new Error("shell.show editor/hook/lab needs an open project");
        }
        showProject(ctx.shell, nextMode);
      }
      if (panel === "newAsset") {
        if (!ctx.shell.openProjectId) {
          throw new Error("shell.show panel=newAsset needs an open project");
        }
        showProject(ctx.shell, "editor");
        await sleep(400);
        requestOpenNewAsset({
          intent: "text_to_image",
          prompt: argString(args, "prompt") || undefined,
          model: argString(args, "model") || undefined,
        });
      }
      return {
        primaryTab: tab,
        librarySurface: tab === "library" ? (surface ?? "creations") : null,
        mode:
          tab === "project"
            ? (mode ?? (panel === "newAsset" ? "editor" : ctx.shell.mode))
            : null,
        panel: panel || null,
        openProjectId: ctx.shell.openProjectId,
      };
    }
    case "project.close": {
      if (!ctx.shell) throw new Error("Shell is not mounted");
      showProject(ctx.shell);
      ctx.shell.closeProject();
      return { ok: true };
    }
    case "project.delete": {
      if (!ctx.shell) throw new Error("Shell is not mounted");
      showProject(ctx.shell);
      const id =
        argString(args, "id") ||
        argString(args, "projectId") ||
        ctx.shell.openProjectId ||
        "";
      if (!id) throw new Error("project.delete requires id");
      let folderId: string | null = null;
      try {
        folderId = (await getProjectFolder(id)).id;
      } catch {
        /* already released */
      }
      const ok = await ctx.shell.deleteProject(id);
      if (!ok) throw new Error("Could not delete project");
      if (folderId) {
        try {
          await deleteFolder(folderId);
        } catch {
          /* leftover folder may still have members */
        }
      }
      try {
        await ctx.shell.syncProjectFolders();
      } catch {
        /* cloud folder flush is best-effort teardown */
      }
      return { projectId: id, folderId };
    }
    case "folder.create": {
      showLibrary(ctx.shell, "creations");
      const title = argString(args, "title") || "Agent folder";
      const folder = await createFolder(title, []);
      return {
        folderId: folder.id,
        title: folder.title,
        kind: folder.kind,
        memberCount: folder.memberCount,
        projectId: folder.projectId,
      };
    }
    case "folder.delete": {
      showLibrary(ctx.shell, "creations");
      const id = argString(args, "id") || argString(args, "folderId");
      if (!id) throw new Error("folder.delete requires id");
      await deleteFolder(id);
      if (ctx.shell) {
        try {
          await ctx.shell.syncProjectFolders();
        } catch {
          /* cloud folder flush is best-effort teardown */
        }
      }
      return { folderId: id };
    }
    case "generation.start": {
      if (!ctx.shell) throw new Error("Shell is not mounted");
      const projectId =
        argString(args, "projectId") || ctx.shell.openProjectId || "";
      if (!projectId) throw new Error("generation.start needs an open project");
      if (ctx.shell.openProjectId !== projectId) {
        showProject(ctx.shell, "director");
        const opened = await ctx.shell.openProject(projectId, true);
        if (!opened) throw new Error("Could not open project for generate");
        await sleep(800);
      }
      const route = stillRoute(argString(args, "model"));
      if (!route) throw new Error("No Parascene product still model is available");
      const prompt = argString(args, "prompt") || DEFAULT_STILL_PROMPT;
      showProject(ctx.shell, "editor");
      await sleep(400);
      requestOpenNewAsset({
        intent: "text_to_image",
        prompt,
        model: route.value,
      });
      await sleep(700);
      const result = await runLabParasceneGenerate({
        projectId,
        projectTitle: ctx.shell.project?.title ?? "Untitled project",
        imagesGroupId: ctx.shell.project?.imagesGroupId,
        videosGroupId: ctx.shell.project?.videosGroupId,
        serverId: route.serverId,
        method: route.method,
        args: {
          prompt,
          aspect_ratio: "1:1",
          model: route.value,
        },
        mediaType: "image",
        intent: "text_to_image",
        label: route.label || route.method,
      });
      showProject(ctx.shell, "editor");
      if (result.creationId) {
        window.dispatchEvent(
          new CustomEvent("parascene-library-asset-selected", {
            detail: { assetId: result.creationId },
          }),
        );
      }
      return {
        creationId: result.creationId,
        projectId,
        imagesGroupId: result.imagesGroupId,
        model: route.value,
      };
    }
    case "cloud.delete": {
      const ids = collectDeleteIds(args);
      if (ids.length === 0) throw new Error("cloud.delete requires id");
      showLibrary(ctx.shell, "creations");
      const result = await purgeCreations(ids, ctx.shell);
      window.dispatchEvent(new CustomEvent("parascene-library-reload"));
      return result;
    }
    case "library.lookup": {
      const ids = collectDeleteIds(args);
      const found: Array<{ id: string; title: string }> = [];
      for (const id of ids) {
        const row = await catalogRow(id);
        if (row) found.push({ id: row.id, title: row.title });
      }
      return { ids, found };
    }
    case "sync.start": {
      showLibrary(ctx.shell, "sync");
      const result = await runSyncNewest();
      window.dispatchEvent(new CustomEvent("parascene-library-reload"));
      return {
        added: result.added,
        pruned: result.pruned,
        checked: result.checked,
        statusTotal: result.status.total,
        lastSyncAt: result.status.lastSyncAt,
      };
    }
    case "sync.folders": {
      if (!ctx.shell) throw new Error("Shell is not mounted");
      showLibrary(ctx.shell, "sync");
      const folderResult = await ctx.shell.syncProjectFolders();
      await ctx.shell.reconcileProjectsAfterLibrarySync({
        refreshCoversFromList: true,
      });
      window.dispatchEvent(new CustomEvent("parascene-library-reload"));
      if (!folderResult.ok && folderResult.conflicts.length === 0) {
        throw new Error(folderResult.message || "Folder sync failed");
      }
      return {
        ok: folderResult.ok,
        pendingCount: folderResult.pendingCount,
        conflicts: folderResult.conflicts.length,
        message: folderResult.message ?? null,
      };
    }
    case "sync.thumbs": {
      showLibrary(ctx.shell, "sync");
      const queued = await cacheMissingThumbs();
      const status =
        queued.status.missingThumbCacheable === 0
          ? queued.status
          : await waitForCache("thumbs", 5 * 60_000);
      showLibrary(ctx.shell, "sync");
      window.dispatchEvent(new CustomEvent("parascene-library-reload"));
      return {
        withThumb: status.withThumb,
        missingThumbCacheable: status.missingThumbCacheable,
        thumbsBytes: status.thumbsBytes,
      };
    }
    case "sync.media": {
      showLibrary(ctx.shell, "sync");
      const queued = await cacheMissingMedia();
      const status =
        queued.status.missingMediaCacheable === 0
          ? queued.status
          : await waitForCache("media", 14 * 60_000);
      showLibrary(ctx.shell, "sync");
      window.dispatchEvent(new CustomEvent("parascene-library-reload"));
      return {
        withMedia: status.withMedia,
        missingMediaCacheable: status.missingMediaCacheable,
        mediaBytes: status.mediaBytes,
      };
    }
    case "library.clearLocal": {
      if (args?.confirm !== true) {
        throw new Error("library.clearLocal requires confirm: true");
      }
      showLibrary(ctx.shell, "creations");
      const status = await clearSyncedLocal();
      window.dispatchEvent(new CustomEvent("parascene-library-reload"));
      return {
        cleared: true,
        total: status.total,
        remote: status.remote,
        lastSyncAt: status.lastSyncAt,
      };
    }
    default:
      throw new Error(`UI cannot handle ${action}`);
  }
}
