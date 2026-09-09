import { listen } from "@tauri-apps/api/event";
import {
  ensureRenderMediaLocal,
  getTimelineRender,
  startTimelineRender,
  timelineClipsToRenderInput,
  type RenderFinished,
  type TimelineRender,
} from "../publisher/renderClient";
import type { useShellOptional } from "../app/ShellProvider";
import { settleEditorForHelpShot } from "./runAgentA2v";

type Shell = NonNullable<ReturnType<typeof useShellOptional>>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Publisher render on the Hook page — same start path as the Render button
 * after confirm (ensure local files, then the publisher render service).
 */
export async function runAgentPublisherRender(opts: {
  shell: Shell;
  projectId: string;
}): Promise<{
  renderId: string;
  path: string;
  durationSec: number;
  status: string;
}> {
  const { shell, projectId } = opts;
  if (shell.openProjectId !== projectId) {
    shell.setPrimaryTab("project");
    const opened = await shell.openProject(projectId, true);
    if (!opened) throw new Error("Could not open project for publisher render");
    await sleep(800);
  }
  shell.setPrimaryTab("project");
  shell.setMode("hook");
  await settleEditorForHelpShot(shell);
  await sleep(400);

  const clips = timelineClipsToRenderInput(shell.project?.timeline ?? []);
  if (clips.length === 0) throw new Error("publisher.render needs clips on the timeline");
  const audioClips = clips.filter((clip) => clip.lane === "audio");
  if (audioClips.length === 0) {
    throw new Error("publisher.render needs audio on the timeline");
  }

  const finished = await watchRenderFinished(projectId);
  await ensureRenderMediaLocal(clips);
  await startTimelineRender(
    projectId,
    shell.project?.aspectRatio ?? "16:9",
    clips,
    shell.project?.looks,
  );
  const event = await finished.result;
  if (!event.ok) {
    throw new Error(event.error?.trim() || "Publisher render failed");
  }
  if (!event.renderId) {
    throw new Error("publisher.render finished without a render id");
  }
  const render = await waitForReadyRender(projectId, event.renderId);
  return {
    renderId: render.id,
    path: render.path,
    durationSec: render.durationSec,
    status: render.status,
  };
}

async function watchRenderFinished(projectId: string): Promise<{
  result: Promise<RenderFinished>;
}> {
  const deferred: {
    resolve: (event: RenderFinished) => void;
    reject: (err: Error) => void;
  } = {
    resolve: () => {},
    reject: () => {},
  };
  const result = new Promise<RenderFinished>((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  let settled = false;
  let unlisten = () => {};
  const timer = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    unlisten();
    deferred.reject(new Error("publisher.render timed out waiting for encode"));
  }, 6 * 60_000);
  unlisten = await listen<RenderFinished>("publisher-render-finished", (event) => {
    if (event.payload.projectId !== projectId) return;
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    unlisten();
    deferred.resolve(event.payload);
  });
  return { result };
}

async function waitForReadyRender(
  projectId: string,
  renderId: string,
): Promise<TimelineRender> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const render = await getTimelineRender(projectId, renderId);
    if (render.status === "ready" && render.path) return render;
    if (render.status === "failed") {
      throw new Error(render.error?.trim() || "Publisher render failed");
    }
    await sleep(200);
  }
  throw new Error("publisher.render finished but the file was not ready");
}
