import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HELP_ROOT = join(process.cwd(), "public/help");

const JOURNEYS = [
  "getting-started.html",
  "sync.html",
  "projects.html",
  "folders.html",
  "generate.html",
] as const;

function readHelp(rel: string): string {
  return readFileSync(join(HELP_ROOT, rel), "utf8");
}

describe("help pages", () => {
  it("lists Start here, Topics, Setup, and Screens from the contents page", () => {
    const html = readHelp("index.html");
    expect(html).toContain("class=\"lead\"");
    expect(html).toContain("Start here");
    expect(html).toContain("Topics");
    expect(html).toContain("Setup");
    expect(html).toContain("Screens");
    expect(html).not.toContain("Journeys");
    expect(html).toContain("Getting started");
    expect(html).toContain("getting-started.html");
    expect(html).toContain("sync.html");
    expect(html).toContain("projects.html");
    expect(html).toContain("folders.html");
    expect(html).toContain("generate.html");
    expect(html).toContain("tools.html");
    expect(html).toContain("Local tools");
    expect(html).toContain("Overview");
    expect(html).toContain("overview.html");
  });

  it("is one scrolling Overview with a back link", () => {
    const overview = readHelp("overview.html");
    expect(overview).toContain('href="index.html">All topics</a>');
    expect(overview).toContain("<h1>Overview</h1>");
    expect(overview).toContain("id=\"projects\"");
    expect(overview).toContain("id=\"library\"");
    expect(overview).toContain("id=\"sync\"");
    expect(overview).toContain("id=\"director\"");
    expect(overview).toContain("id=\"editor\"");
    expect(overview).toContain("desktop/screens/library.png");
    expect(overview).toContain("desktop/screens/editor-new-asset.png");
    expect(overview).toContain('src="help.js"');
  });

  it("gives each topic a back link and the tested button labels", () => {
    for (const page of JOURNEYS) {
      const html = readHelp(page);
      expect(html, page).toContain('href="index.html">All topics</a>');
      expect(html, page).toContain('src="help.js"');
    }

    const start = readHelp("getting-started.html");
    expect(start).toContain("<h1>Getting started</h1>");
    expect(start).toContain("Log in");
    expect(start).toContain("desktop/screens/library.png");
    expect(start).toContain("desktop/screens/sync.png");
    expect(start).toContain("desktop/screens/projects.png");
    expect(start).toContain("desktop/screens/director.png");
    expect(start).toContain("desktop/screens/editor.png");
    expect(start).toContain("desktop/screens/editor-new-asset.png");
    expect(start).toContain("Add from disk…");
    expect(start).toContain("No recent projects yet.");
    expect(start).toContain("New project");
    expect(start).toContain("Untitled project");
    expect(start).toContain("Add asset");
    expect(start).toContain("Text to Image");

    const sync = readHelp("sync.html");
    expect(sync).toContain("<h1>Sync</h1>");
    expect(sync).toContain("Sync newest");
    expect(sync).toContain("Ready");
    expect(sync).toContain("Sync folders");
    expect(sync).toContain("Sync full catalog");

    const projects = readHelp("projects.html");
    expect(projects).toContain("<h1>Projects</h1>");
    expect(projects).toContain("New project");
    expect(projects).toContain("Close project");
    expect(projects).toContain("Delete project");
    expect(projects).toContain("Untitled project");

    const folders = readHelp("folders.html");
    expect(folders).toContain("<h1>Folders</h1>");
    expect(folders).toContain("New folder…");
    expect(folders).toContain("New project…");
    expect(folders).toContain("regular");
    expect(folders).toContain("project folder");

    const generate = readHelp("generate.html");
    expect(generate).toContain("<h1>Generate an image</h1>");
    expect(generate).toContain("Add asset");
    expect(generate).toContain("Text to Image");
    expect(generate).toContain("Parascene");
    expect(generate).toContain("sd15: lofi_V2pre");
    expect(generate).toContain("Generate");
  });

  it("tells users Settings shows whether the app can see each tool", () => {
    const tools = readHelp("tools.html");
    expect(tools).toContain('href="index.html">All topics</a>');
    expect(tools).toContain('src="help.js"');
    expect(tools).toContain("<h1>Local tools</h1>");
    expect(tools).toContain("See what the app can find");
    expect(tools).toContain("Settings");
    expect(tools).toContain("Local tools");
    expect(tools).toContain("ready");
    expect(tools).toContain("missing");
    expect(tools).toContain("Re-check");
    expect(tools).toContain("Install demucs");
    expect(tools).toContain("FFmpeg");
    expect(tools).toContain("Demucs");
    expect(tools).toContain("Whisper");
    expect(tools).toContain("brew install ffmpeg");
    expect(tools).toContain("winget install ffmpeg");
    expect(tools).toContain('class="for-mac"');
    expect(tools).toContain('class="for-windows"');
    expect(tools).toContain('data-os="mac"');
    expect(tools).toContain('data-os="windows"');
  });
});
