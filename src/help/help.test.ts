import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TEST_GENERATE_PROMPT } from "../fixtures/agentTestGenerate";
import { AGENT_TEST_SPEECH_TEXT } from "../fixtures/agentTestSpeech";

const HELP_ROOT = join(process.cwd(), "public/help");

const JOURNEYS = [
  "getting-started.html",
  "sync.html",
  "projects.html",
  "folders.html",
  "generate.html",
  "audio.html",
  "image-models.html",
  "video-models.html",
] as const;

function readHelp(rel: string): string {
  return readFileSync(join(HELP_ROOT, rel), "utf8");
}

describe("help pages", () => {
  it("lists Start here, Topics, and Setup from the contents page", () => {
    const html = readHelp("index.html");
    expect(html).toContain("class=\"lead\"");
    expect(html).toContain("Start here");
    expect(html).toContain("Topics");
    expect(html).toContain("Setup");
    expect(html).not.toContain("Screens");
    expect(html).not.toContain("Journeys");
    expect(html).not.toContain("Overview");
    expect(html).not.toContain("overview.html");
    expect(html).toContain("Getting started");
    expect(html).toContain("getting-started.html");
    expect(html).toContain("sync.html");
    expect(html).toContain("projects.html");
    expect(html).toContain("folders.html");
    expect(html).toContain("generate.html");
    expect(html).toContain("audio.html");
    expect(html).toContain("Generate a video with audio");
    expect(html).toContain("settings.html");
    expect(html).toContain("Settings");
    expect(html).toContain("tools.html");
    expect(html).toContain("Local tools");
    expect(html).toContain('class="help-wordmark"');
    expect(html).toContain('class="topic-icon"');
    expect(html.match(/class="topic-icon"/g)?.length).toBe(11);
    expect(html).toContain("local-and-cloud.html");
    expect(html).toContain("This computer and the cloud");
    expect(html).toContain("image-models.html");
    expect(html).toContain("Image models");
    expect(html).toContain("video-models.html");
    expect(html).toContain("Video models");
  });

  it("ships Inter with help pages", () => {
    const css = readHelp("help.css");
    expect(css).toContain("Inter Variable");
    expect(css).toContain("fonts/inter-latin-wght-normal.woff2");
    expect(css).toContain("fonts/inter-latin-ext-wght-normal.woff2");
    expect(css).toContain(".help-lightbox");
    expect(css).toContain(".model-names");
    expect(css).toContain(".catalog-split");
    expect(css).toContain(".model-brand");
    expect(css).toContain(".home-icon");
    const js = readHelp("help.js");
    expect(js).toContain("help-lightbox");
    expect(js).toContain("Escape");
  });

  it("keeps first-run screen headings on Getting started, not a second Overview", () => {
    const start = readHelp("getting-started.html");
    expect(start).toContain('class="home-icon"');
    expect(start).toContain("All topics");
    expect(start).toContain("<h1>Getting started</h1>");
    expect(start).toContain("id=\"library\"");
    expect(start).toContain("id=\"projects\"");
    expect(start).toContain("id=\"director\"");
    expect(start).toContain("id=\"editor\"");
    expect(start).not.toContain("id=\"sync\"");
    expect(start).not.toContain("desktop/screens/sync.png");
    expect(start).not.toContain("Sync newest");
    expect(start).not.toContain("overview.html");
    expect(start).toContain("desktop/screens/library.png");
    expect(start).toContain("desktop/screens/editor-new-asset.png");
    expect(start).toContain('src="help.js"');
  });

  it("gives each topic a back link and the tested button labels", () => {
    for (const page of JOURNEYS) {
      const html = readHelp(page);
      expect(html, page).toContain('class="home-icon"');
      expect(html, page).toContain("All topics");
      expect(html, page).toContain('src="help.js"');
    }

    const start = readHelp("getting-started.html");
    expect(start).toContain("<h1>Getting started</h1>");
    expect(start).toContain("Log in");
    expect(start).toContain("desktop/screens/login.png");
    expect(start).toContain("desktop/screens/library.png");
    expect(start).not.toContain("desktop/screens/sync.png");
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
    expect(start).toContain("Where to go from here");
    expect(start).toContain("generate.html");
    expect(start).not.toContain("audio.html");

    const sync = readHelp("sync.html");
    expect(sync).toContain("<h1>Sync</h1>");
    expect(sync).toContain("Sync newest");
    expect(sync).toContain("Ready");
    expect(sync).toContain("Sync folders");
    expect(sync).toContain("Sync full catalog");
    expect(sync).toContain("local-and-cloud.html");

    const projects = readHelp("projects.html");
    expect(projects).toContain("<h1>Projects</h1>");
    expect(projects).toContain("New project");
    expect(projects).toContain("Close project");
    expect(projects).toContain("Delete project");
    expect(projects).toContain("Untitled project");
    expect(projects).toContain("this computer");
    expect(projects).toContain("local-and-cloud.html");

    const folders = readHelp("folders.html");
    expect(folders).toContain("<h1>Folders</h1>");
    expect(folders).toContain("New folder…");
    expect(folders).toContain("New project…");
    expect(folders).toContain("regular");
    expect(folders).toContain("project folder");
    expect(folders).toContain("local-and-cloud.html");

    const generate = readHelp("generate.html");
    expect(generate).toContain("<h1>Generate an image</h1>");
    expect(generate).toContain("Add asset");
    expect(generate).toContain("Text to Image");
    expect(generate).toContain("Parascene");
    expect(generate).toContain("X.ai Grok Imagine Image");
    expect(generate).toContain("Generate");
    expect(generate).toContain(AGENT_TEST_GENERATE_PROMPT);
    expect(generate).toContain("desktop/screens/editor-generate-prompt.png");
    expect(generate).toContain("desktop/screens/editor-generate-result.png");
    expect(generate).toContain("desktop/media/agent-test-still.png");
    expect(generate).toContain("Where to go from here");
    expect(generate).toContain("audio.html");

    const index = readHelp("index.html");
    const startHere = index.slice(
      index.indexOf("Start here"),
      index.indexOf("Topics"),
    );
    expect(startHere).toContain("getting-started.html");
    expect(startHere).toContain("generate.html");
    expect(startHere).toContain("audio.html");
    const topics = index.slice(index.indexOf("Topics"), index.indexOf("Setup"));
    expect(topics).not.toContain("audio.html");
    expect(topics).toContain("local-and-cloud.html");
    expect(topics).toContain("image-models.html");
    expect(topics).toContain("video-models.html");
    expect(startHere).not.toContain("local-and-cloud.html");
    expect(startHere).not.toContain("image-models.html");
    expect(startHere).not.toContain("video-models.html");
    const setup = index.slice(index.indexOf("Setup"));
    expect(setup).toContain("settings.html");
    expect(setup).toContain("tools.html");
    expect(topics).not.toContain("settings.html");
    expect(setup).not.toContain("overview.html");

    const audio = readHelp("audio.html");
    expect(audio).toContain("<h1>Generate a video with audio</h1>");
    expect(audio).toContain('href="generate.html">Generate an image</a>');
    expect(audio).not.toContain("Log in");
    expect(audio).toContain("Add from disk…");
    expect(audio).toContain("Audio to Video");
    expect(audio).toContain("ltx_a2v");
    expect(audio).toContain("full mix");
    expect(audio).toContain("Where to go from here");
    expect(audio).toContain("tools.html");
    expect(audio).toContain(AGENT_TEST_SPEECH_TEXT);
    expect(audio).toContain("desktop/media/agent-test-speech.mp3");
    expect(audio).toContain("desktop/media/agent-test-speech.mp4");
    expect(audio).toContain("9 seconds");
    expect(audio).toContain("don't trim");
    expect(audio).toContain("desktop/media/agent-test-still.png");
    expect(audio).toContain("desktop/screens/editor-audio-timeline.png");
    expect(audio).toContain("desktop/screens/editor-a2v-form.png");
    expect(audio).toContain("desktop/screens/editor-a2v.png");
    expect(audio).toContain("video lane is still empty");
    expect(audio).toContain("<audio");
    expect(audio).toContain("<video");
    expect(audio).not.toMatch(/the (A2V |desktop )?test/i);
    expect(audio).not.toContain("writes this screenshot");
    expect(generate).not.toMatch(/the (A2V |desktop )?test/i);

    const models = readHelp("image-models.html");
    expect(models).toContain("<h1>Image models</h1>");
    expect(models).toContain(AGENT_TEST_GENERATE_PROMPT);
    expect(models).toContain("Where to go from here");
    expect(models).toContain("generate.html");
    expect(models).toContain("<h2>Z-Image</h2>");
    expect(models).toContain("<h2>Image edit</h2>");
    expect(models).toContain("class=\"model-names\"");
    expect(models).not.toContain("desktop/media/models/replicate-prunaai-p-image-edit.png");
    expect(models).not.toContain("desktop/media/models/replicate-qwen-image-edit.png");
    expect(models).not.toContain(
      "desktop/media/models/replicate-pro-bfl-flux-2-pro-multi-image-edit.png",
    );
    expect(models).not.toContain(
      "desktop/media/models/blue-qwen-qwen-image-edit-fp8-e4m3fn.png",
    );
    expect(models).not.toContain(
      "desktop/media/models/blue-flux-flux1-dev-kontext-fp8-scaled.png",
    );
    expect(models).not.toContain("desktop/screens/");

    const videoModels = readHelp("video-models.html");
    expect(videoModels).toContain("<h1>Video models</h1>");
    expect(videoModels).toContain("catalog-split");
    expect(videoModels).toContain("<h2>Models</h2>");
    expect(videoModels).toContain("<h2>Intents</h2>");
    expect(videoModels).toContain("model-brand--wan");
    expect(videoModels).toContain("model-brand--ltx");
    expect(videoModels).toContain("model-brand--minimax");
    expect(videoModels).toContain("Text to Video");
    expect(videoModels).toContain("Image to Video");
    expect(videoModels).toContain("Audio to Video");
    expect(videoModels).toContain("Video to Video");
    expect(videoModels).toContain("copy the motion");
    expect(videoModels).toContain("Invent a clip");
    expect(videoModels).toContain("Make a still move");
    expect(videoModels).toContain("talking clip");
    expect(videoModels).toContain("Hold onto who");
    expect(videoModels).toContain("Refs to Video");
    expect(videoModels).toContain("Wan");
    expect(videoModels).toContain("LTX");
    expect(videoModels).toContain("MiniMax H3");
    expect(videoModels).toContain("ltx_a2v");
    expect(videoModels).toContain("Direct to Blue");
    expect(videoModels).toContain("Replicate");
    expect(videoModels).toContain("Where to go from here");
    expect(videoModels).toContain("audio.html");
    expect(videoModels).toContain("image-models.html");
    expect(videoModels).not.toContain("desktop/screens/");
    expect(videoModels).not.toMatch(/general overview/i);
    expect(generate).not.toContain("writes this screenshot");
    expect(existsSync(join(HELP_ROOT, "desktop/media/agent-test-speech.wav"))).toBe(true);
    expect(existsSync(join(HELP_ROOT, "desktop/media/agent-test-speech.mp3"))).toBe(true);
    expect(existsSync(join(HELP_ROOT, "desktop/media/agent-test-speech.mp4"))).toBe(true);
    expect(existsSync(join(HELP_ROOT, "desktop/media/agent-test-still.png"))).toBe(true);
    expect(existsSync(join(HELP_ROOT, "desktop/screens/editor-audio-timeline.png"))).toBe(
      true,
    );
    expect(existsSync(join(HELP_ROOT, "desktop/screens/editor-a2v.png"))).toBe(true);
    expect(existsSync(join(HELP_ROOT, "desktop/screens/editor-a2v-form.png"))).toBe(
      true,
    );
    const editorPng = readFileSync(join(HELP_ROOT, "desktop/screens/editor.png"));
    const audioTl = readFileSync(
      join(HELP_ROOT, "desktop/screens/editor-audio-timeline.png"),
    );
    const a2vForm = readFileSync(
      join(HELP_ROOT, "desktop/screens/editor-a2v-form.png"),
    );
    const a2vScreen = readFileSync(join(HELP_ROOT, "desktop/screens/editor-a2v.png"));
    expect(audioTl.equals(editorPng), "timeline shot must come from the A2V test").toBe(
      false,
    );
    expect(a2vScreen.equals(editorPng), "after shot must come from the A2V test").toBe(
      false,
    );
    expect(audioTl.equals(a2vScreen), "before and after shots must differ").toBe(false);
    expect(audioTl.equals(a2vForm), "timeline shot must not be the form shot").toBe(
      false,
    );
    expect(a2vForm.equals(a2vScreen), "form shot must not be the after shot").toBe(
      false,
    );
  });

  it("never mentions tests in the user-facing articles", () => {
    const pages = [
      "index.html",
      "local-and-cloud.html",
      "settings.html",
      "tools.html",
      ...JOURNEYS,
    ];
    for (const page of pages) {
      const html = readHelp(page);
      expect(html, page).not.toMatch(/the (A2V |desktop )?test/i);
      expect(html, page).not.toContain("writes this screenshot");
      expect(html, page).not.toContain("This page does not repeat");
    }
  });

  it("explains this computer versus the cloud without a second screen tour", () => {
    const html = readHelp("local-and-cloud.html");
    expect(html).toContain('class="home-icon"');
    expect(html).toContain("All topics");
    expect(html).toContain('src="help.js"');
    expect(html).toContain("<h1>This computer and the cloud</h1>");
    expect(html).toContain("On this computer");
    expect(html).toContain("On Parascene");
    expect(html).toContain("How they meet");
    expect(html).toContain("What delete does");
    expect(html).toContain("Add from disk…");
    expect(html).toContain("Direct to Blue");
    expect(html).toContain("Replicate");
    expect(html).toContain("This desktop");
    expect(html).toContain("Delete project");
    expect(html).toContain("sync.html");
    expect(html).toContain("projects.html");
    expect(html).not.toContain("desktop/screens/");
    expect(html).not.toContain("overview.html");
    expect(html).not.toMatch(/the (A2V |desktop )?test/i);
  });

  it("tells users Settings shows whether the app can see each tool", () => {
    const tools = readHelp("tools.html");
    expect(tools).toContain('class="home-icon"');
    expect(tools).toContain("All topics");
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

  it("walks every control in the Settings dialog", () => {
    const settings = readHelp("settings.html");
    expect(settings).toContain('class="home-icon"');
    expect(settings).toContain("All topics");
    expect(settings).toContain('src="help.js"');
    expect(settings).toContain("<h1>Settings</h1>");
    expect(settings).toContain("desktop/screens/settings.png");
    expect(settings).toContain("OpenAI API key");
    expect(settings).toContain("Replicate API token");
    expect(settings).toContain("Clear Replicate token");
    expect(settings).toContain("Parascene Blue credentials");
    expect(settings).toContain("Clear Blue credentials");
    expect(settings).toContain("Show Labs");
    expect(settings).toContain("Low");
    expect(settings).toContain("Medium");
    expect(settings).toContain("High");
    expect(settings).toContain("Editor preview");
    expect(settings).toContain("Local tools");
    expect(settings).toContain("Re-check");
    expect(settings).toContain("Install demucs");
    expect(settings).toContain("Open LOCAL_TOOLS.md");
    expect(settings).toContain("Save");
    expect(settings).toContain("Cancel");
    expect(settings).toContain("tools.html");
    expect(settings).toContain("local-and-cloud.html");
    expect(settings).not.toMatch(/the (A2V |desktop )?test/i);
    expect(existsSync(join(HELP_ROOT, "desktop/screens/settings.png"))).toBe(true);
  });
});
