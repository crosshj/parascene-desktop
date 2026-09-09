import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AGENT_TEST_EDITOR_A2V_FORM_SCREEN,
  AGENT_TEST_EDITOR_A2V_SCREEN,
  AGENT_TEST_EDITOR_AUDIO_SCREEN,
  AGENT_TEST_STILL_PATH,
  AGENT_TEST_VIDEO_PATH,
} from "../src/fixtures/agentTestSpeech";

const execFileAsync = promisify(execFile);

export const HELP_SCREEN_PATHS = {
  editorAudioTimeline: AGENT_TEST_EDITOR_AUDIO_SCREEN,
  editorA2vForm: AGENT_TEST_EDITOR_A2V_FORM_SCREEN,
  editorA2v: AGENT_TEST_EDITOR_A2V_SCREEN,
} as const;

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function publishHelpStill(
  src: string,
  dest: string,
): Promise<string> {
  await ensureParent(dest);
  await copyFile(src, dest);
  return dest;
}

export async function publishHelpAudio(
  src: string,
  dest: string,
): Promise<string> {
  return publishHelpStill(src, dest);
}

/** Copy a generated still/video into the help media folder the articles embed. */
export async function publishHelpMedia(opts: {
  stillPath?: string | null;
  videoPath?: string | null;
}): Promise<{ still: string | null; video: string | null }> {
  let still: string | null = null;
  let video: string | null = null;
  if (opts.stillPath) {
    still = await publishHelpStill(opts.stillPath, AGENT_TEST_STILL_PATH);
  }
  if (opts.videoPath) {
    await ensureParent(AGENT_TEST_VIDEO_PATH);
    if (extname(opts.videoPath).toLowerCase() === ".mp4") {
      await copyFile(opts.videoPath, AGENT_TEST_VIDEO_PATH);
    } else {
      await execFileAsync("ffmpeg", [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        opts.videoPath,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        AGENT_TEST_VIDEO_PATH,
      ]);
    }
    video = AGENT_TEST_VIDEO_PATH;
  }
  return { still, video };
}

const WINID_SRC = `
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc < 2) return 1;
  int want = atoi(argv[1]);
  CFArrayRef list = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (!list) return 1;
  CFIndex n = CFArrayGetCount(list);
  int best = 0;
  double bestArea = 0;
  for (CFIndex i = 0; i < n; i++) {
    CFDictionaryRef w = (CFDictionaryRef)CFArrayGetValueAtIndex(list, i);
    int pid = 0, layer = -1, wid = 0;
    CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(w, kCGWindowOwnerPID);
    if (pidRef) CFNumberGetValue(pidRef, kCFNumberIntType, &pid);
    if (pid != want) continue;
    CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(w, kCGWindowLayer);
    if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
    if (layer != 0) continue;
    CFDictionaryRef bounds = (CFDictionaryRef)CFDictionaryGetValue(w, kCGWindowBounds);
    double ww = 0, hh = 0;
    if (bounds) {
      CFNumberRef wr = (CFNumberRef)CFDictionaryGetValue(bounds, CFSTR("Width"));
      CFNumberRef hr = (CFNumberRef)CFDictionaryGetValue(bounds, CFSTR("Height"));
      if (wr) CFNumberGetValue(wr, kCFNumberDoubleType, &ww);
      if (hr) CFNumberGetValue(hr, kCFNumberDoubleType, &hh);
    }
    if (ww * hh <= bestArea) continue;
    bestArea = ww * hh;
    CFNumberRef idRef = (CFNumberRef)CFDictionaryGetValue(w, kCGWindowNumber);
    if (idRef) CFNumberGetValue(idRef, kCFNumberIntType, &wid);
    best = wid;
  }
  CFRelease(list);
  if (!best) return 2;
  printf("%d\\n", best);
  return 0;
}
`;

async function agentPid(): Promise<number> {
  const candidates = [
    join(homedir(), "Movies", "Parascene", "agent.json"),
    join(homedir(), "Videos", "Parascene", "agent.json"),
  ];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: number };
      if (parsed.pid) return parsed.pid;
    } catch {
      /* try next */
    }
  }
  throw new Error("Could not read agent.json pid");
}

async function windowIdHelper(): Promise<string> {
  const bin = join(tmpdir(), "parascene-help-winid");
  const src = join(tmpdir(), "parascene-help-winid.c");
  await writeFile(src, WINID_SRC);
  await execFileAsync("cc", [
    "-framework",
    "CoreGraphics",
    "-framework",
    "CoreFoundation",
    "-o",
    bin,
    src,
  ]);
  return bin;
}

async function parasceneWindowId(pid: number): Promise<string> {
  const bin = await windowIdHelper();
  const { stdout } = await execFileAsync(bin, [String(pid)]);
  const id = stdout.trim();
  if (!/^\d+$/.test(id)) throw new Error(`Could not resolve Parascene window id: ${stdout}`);
  return id;
}

/** Capture the running Parascene window into a help screenshot (1280×900 logical). */
export async function captureHelpScreen(
  dest: string,
  opts?: { keepUi?: boolean },
): Promise<string> {
  await ensureParent(dest);
  const pid = await agentPid();
  const dismiss = opts?.keepUi
    ? [
        "-e",
        `tell application "System Events" to set frontmost of first process whose unix id is ${pid} to true`,
        "-e",
        "delay 0.4",
      ]
    : [
        "-e",
        `tell application "System Events" to set frontmost of first process whose unix id is ${pid} to true`,
        "-e",
        "delay 0.2",
        "-e",
        "tell application \"System Events\" to key code 53",
        "-e",
        "delay 0.2",
        "-e",
        "tell application \"System Events\" to key code 53",
      ];
  await execFileAsync("osascript", dismiss);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const windowId = await parasceneWindowId(pid);
  const stamp = Date.now();
  const raw = join(tmpdir(), `help-capture-${stamp}.png`);
  const sized = join(tmpdir(), `help-capture-${stamp}-sized.png`);
  await execFileAsync("screencapture", ["-o", "-x", `-l${windowId}`, raw]);
  await execFileAsync("sips", ["-z", "1800", "2560", raw, "--out", sized]);
  await rename(sized, dest).catch(async () => {
    await copyFile(sized, dest);
    await unlink(sized).catch(() => {});
  });
  await unlink(raw).catch(() => {});
  const info = await stat(dest);
  if (info.size < 50_000) throw new Error(`Help screenshot too small: ${dest}`);
  if (Date.now() - info.mtimeMs > 10_000) {
    throw new Error(`Help screenshot was not updated: ${dest}`);
  }
  return dest;
}

/** Keep `HELP_FILES` in help_window.rs equal to every file under public/help/. */
export async function syncHelpFileList(): Promise<string[]> {
  const root = join(process.cwd(), "public/help");
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(`help/${relative(root, path).replaceAll("\\", "/")}`);
    }
  }
  await walk(root);
  files.sort();
  const rustPath = join(process.cwd(), "src-tauri/src/help_window.rs");
  const rust = await readFile(rustPath, "utf8");
  const next = rust.replace(
    /const HELP_FILES: &\[&str\] = &\[[\s\S]*?\];/,
    `const HELP_FILES: &[&str] = &[\n${files.map((rel) => `    "${rel}",`).join("\n")}\n];`,
  );
  if (next === rust) throw new Error("Could not update HELP_FILES in help_window.rs");
  await writeFile(rustPath, next);
  return files;
}
