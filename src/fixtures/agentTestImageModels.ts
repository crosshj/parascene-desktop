import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parasceneStillModelsForIntent,
  type ParasceneStillModelOption,
} from "../layouts/editor/parasceneProductCaps";
import {
  AGENT_TEST_STILL_ASPECT,
  AGENT_TEST_STILL_MODEL,
  AGENT_TEST_STILL_PATH,
  AGENT_TEST_STILL_PROMPT,
} from "./agentTestSpeech";

const HELP_ROOT = join(process.cwd(), "public/help");
const MEDIA_MODELS = join(HELP_ROOT, "desktop/media/models");

export const AGENT_TEST_IMAGE_MODELS_PROMPT = AGENT_TEST_STILL_PROMPT;
export const AGENT_TEST_IMAGE_MODELS_ASPECT = AGENT_TEST_STILL_ASPECT;

export type ImageModelLineage = {
  id: string;
  title: string;
  era: string;
  blurb: string;
  order: number;
};

const LINEAGES: ImageModelLineage[] = [
  {
    id: "sd15",
    title: "Stable Diffusion 1.5",
    era: "2022",
    blurb:
      "The first wave most people could run. Cheap, fast, and the character often drifts.",
    order: 10,
  },
  {
    id: "sdxl",
    title: "Stable Diffusion XL",
    era: "2023",
    blurb:
      "Bigger than 1.5. Sharper, more coherent, still the same diffusion family.",
    order: 20,
  },
  {
    id: "flux",
    title: "Flux",
    era: "2024",
    blurb: "A new open stack. Prompt-following got a lot tighter.",
    order: 30,
  },
  {
    id: "flux2",
    title: "Flux 2",
    era: "2025",
    blurb: "The Flux follow-up. Stronger detail, still the same prompt.",
    order: 40,
  },
  {
    id: "qwen",
    title: "Qwen Image",
    era: "2025",
    blurb: "Another 2025 still family. Same goblin, different prior.",
    order: 50,
  },
  {
    id: "zimage",
    title: "Z-Image",
    era: "2025",
    blurb: "A fast 2025 still family. Same goblin, fewer steps.",
    order: 55,
  },
  {
    id: "frontier",
    title: "Frontier stills",
    era: "2025–2026",
    blurb:
      "Hosted models on Parascene — Grok, Gemini, GPT Image, Seedream, Recraft, and friends.",
    order: 60,
  },
  {
    id: "pixel",
    title: "PixelLab",
    era: "pixel art",
    blurb: "A different job — the same prompt, in pixels.",
    order: 80,
  },
];

export function agentTestImageModels(): ParasceneStillModelOption[] {
  return parasceneStillModelsForIntent("text_to_image");
}

export function isSharedGrokStill(model: ParasceneStillModelOption): boolean {
  return model.value === AGENT_TEST_STILL_MODEL;
}

/** Edit / Kontext models need a source still — mention on Help, do not generate. */
export function isInputImageEditModel(model: ParasceneStillModelOption): boolean {
  const key = `${model.label} ${model.value}`.toLowerCase();
  return (
    /\bedit\b/.test(key) ||
    key.includes("-edit") ||
    key.includes("_edit") ||
    key.includes("kontext")
  );
}

export function imageEditModels(): ParasceneStillModelOption[] {
  return agentTestImageModels().filter(isInputImageEditModel);
}

/** Recraft wants a pixel size; GPT Image only overlaps Parascene at 1:1; Luma flagged the shared prompt. */
export type ImageModelGenerateTweak = {
  aspectRatio?: string;
  size?: string;
  prompt?: string;
};

const LUMA_PHOTON_PROMPT =
  "Friendly playful purple goblin, Pixar-style 3D character, waist-up portrait facing the camera. Huge pointed ears, yellow goggles on his bald forehead, warm yellow-green eyes, a small mischievous smile. Plain dark coat, soft purple hands at the bottom of the frame. Dark gray studio backdrop, soft lighting, clean silhouette.";

export function imageModelGenerateTweak(
  model: ParasceneStillModelOption,
): ImageModelGenerateTweak | null {
  if (model.value === "recraft-ai/recraft-v4") return { size: "1344x768" };
  if (model.value === "openai/gpt-image-1.5" || model.value === "openai/gpt-image-2") {
    return { aspectRatio: "1:1" };
  }
  if (model.value === "luma/photon") return { prompt: LUMA_PHOTON_PROMPT };
  return null;
}

export function imageModelSlug(model: ParasceneStillModelOption): string {
  return `${model.family}-${model.label || model.value}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
}

export function imageModelStillRel(model: ParasceneStillModelOption): string {
  if (isSharedGrokStill(model)) return "desktop/media/agent-test-still.png";
  return `desktop/media/models/${imageModelSlug(model)}.png`;
}

export function imageModelStillPath(model: ParasceneStillModelOption): string {
  if (isSharedGrokStill(model)) return AGENT_TEST_STILL_PATH;
  return join(process.cwd(), "public/help", imageModelStillRel(model));
}

export function imageModelLineage(model: ParasceneStillModelOption): ImageModelLineage {
  const key = `${model.label} ${model.value}`.toLowerCase();
  if (model.family === "pixellab") return lineage("pixel");
  if (key.includes("flux-2") || key.includes("flux 2")) return lineage("flux2");
  if (key.includes("flux")) return lineage("flux");
  if (/\bsd15\b/.test(key) || key.includes("checkpoints/1.5")) return lineage("sd15");
  if (/\bsdxl\b/.test(key) || key.includes("/xl/") || key.includes("pony")) {
    return lineage("sdxl");
  }
  if (key.includes("qwen")) return lineage("qwen");
  if (key.includes("z-image") || key.includes("z_image")) return lineage("zimage");
  return lineage("frontier");
}

function lineage(id: string): ImageModelLineage {
  return LINEAGES.find((row) => row.id === id) ?? LINEAGES[LINEAGES.length - 1]!;
}

export function imageModelsByLineage(): Array<{
  lineage: ImageModelLineage;
  models: ParasceneStillModelOption[];
}> {
  const grouped = new Map<string, ParasceneStillModelOption[]>();
  for (const model of agentTestImageModels()) {
    if (isInputImageEditModel(model)) continue;
    const row = imageModelLineage(model);
    const list = grouped.get(row.id) ?? [];
    list.push(model);
    grouped.set(row.id, list);
  }
  return LINEAGES.filter((row) => grouped.has(row.id)).map((row) => ({
    lineage: row,
    models: grouped.get(row.id) ?? [],
  }));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function removeEditModelStills(): void {
  for (const model of imageEditModels()) {
    const dest = imageModelStillPath(model);
    if (existsSync(dest)) unlinkSync(dest);
  }
}

function imageEditSectionHtml(): string {
  const names = imageEditModels();
  if (names.length === 0) return "";
  const items = names
    .map((model) => `        <li>${escapeHtml(model.label)}</li>`)
    .join("\n");
  return `
      <h2>Image edit</h2>
      <p>
        A few models start from a still you already have, not from a prompt
        alone. Use those when you want to change a picture — they are not in
        the grid above.
      </p>
      <ul class="model-names">
${items}
      </ul>`;
}

/** Writes the Topics page from the live model list. Call after stills are on disk. */
export function writeImageModelsHelpPage(): string {
  mkdirSync(MEDIA_MODELS, { recursive: true });
  removeEditModelStills();
  const sections = imageModelsByLineage()
    .map(({ lineage: row, models }) => {
      const withStill = models.filter((model) => existsSync(imageModelStillPath(model)));
      if (withStill.length === 0) return "";
      const cards = withStill
        .map((model) => {
          const src = imageModelStillRel(model);
          return `      <figure class="model-card">
        <img src="${src}" alt="${escapeHtml(model.label)}" />
        <figcaption>${escapeHtml(model.label)}</figcaption>
      </figure>`;
        })
        .join("\n");
      return `      <h2>${escapeHtml(row.title)}</h2>
      <p>${escapeHtml(row.era)}. ${escapeHtml(row.blurb)}</p>
      <div class="model-grid">
${cards}
      </div>`;
    })
    .filter(Boolean)
    .join("\n\n");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Image models — Parascene Help</title>
    <link rel="stylesheet" href="help.css" />
  </head>
  <body>
    <header class="help-top">
      <a class="back" href="index.html">
        <svg class="home-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
          <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        All topics
      </a>
    </header>
    <main>
      <h1>Image models</h1>
      <p>
        One prompt. Every Text to Image model on Parascene. Same goblin, so you
        can see how the family and the checkpoint change the still.
      </p>

      <h2>The prompt we used</h2>
      <pre><code>${escapeHtml(AGENT_TEST_IMAGE_MODELS_PROMPT)}</code></pre>

${sections}
${imageEditSectionHtml()}

      <h2>Where to go from here</h2>
      <p class="more">
        <a href="generate.html">Generate an image</a> — pick one of these
        models and make the still in your project.
      </p>
    </main>
    <script src="help.js"></script>
  </body>
</html>
`;
  const dest = join(HELP_ROOT, "image-models.html");
  writeFileSync(dest, html);
  return dest;
}
