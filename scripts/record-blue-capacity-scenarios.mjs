#!/usr/bin/env node
// Record docs/blue-capacity-scenarios.html?tour=1 to an mp4.
//
//   npx --yes playwright install chromium
//   npx --yes -p playwright node scripts/record-blue-capacity-scenarios.mjs
//
// Needs ffmpeg on PATH to wrap the WebM as mp4.

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = path.join(root, "docs/blue-capacity-scenarios.html");
const outMp4 = path.join(root, "docs/blue-capacity-scenarios.mp4");
const dir = await mkdtemp(path.join(tmpdir(), "blue-capacity-"));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 1100 },
  recordVideo: { dir, size: { width: 1280, height: 1100 } }
});
const page = await context.newPage();
await page.goto(`${pathToFileURL(html).href}?tour=1`);
await page.waitForFunction(() => document.documentElement.dataset.tour === "done", {
  timeout: 20 * 60 * 1000
});
await page.waitForTimeout(800);
await context.close();
await browser.close();

const webm = (await readdir(dir)).find((f) => f.endsWith(".webm"));
if (!webm) {
  throw new Error("Playwright did not write a video");
}
const webmPath = path.join(dir, webm);
const ff = spawnSync(
  "ffmpeg",
  ["-y", "-i", webmPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outMp4],
  { stdio: "inherit" }
);
await rm(dir, { recursive: true, force: true });
if (ff.status !== 0) {
  throw new Error("ffmpeg failed; WebM was in " + webmPath);
}
console.log(outMp4);
