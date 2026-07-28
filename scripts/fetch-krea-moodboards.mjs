#!/usr/bin/env node
/**
 * Crawl Krea's public preset-moodboards API into a slim catalog JSON.
 *
 * Regenerated output — do not hand-edit:
 *   src/data/krea-moodboards.json
 *
 * Moodboard names, keywords, taste profiles, and preview image URLs come from
 * krea.ai's public gallery (unofficial; not affiliated with or endorsed by Krea).
 * The `id` field is the UUID used for Krea 2 generation moodboard references.
 *
 * Usage: node scripts/fetch-krea-moodboards.mjs
 *    or: npm run fetch:krea-moodboards
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://www.krea.ai/api/preset-moodboards";
const LIMIT = 96;
const SEED = 42;
const PAGE_DELAY_MS = 200;
const PREVIEW_SIZE = 256;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "src", "data");
const OUT_FILE = path.join(OUT_DIR, "krea-moodboards.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} sourceUrl */
function toCdnPreviewUrl(sourceUrl, size = PREVIEW_SIZE) {
  const encoded = sourceUrl.replace("://", "---").replace(/[./]/g, "-");
  return `https://optim-images.krea.ai/${encoded}-${size}.webp`;
}

/** @param {string} name */
function toSlug(name) {
  const ascii = name.normalize("NFD").replace(/\p{M}/gu, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "moodboard";
}

async function crawlAll() {
  /** @type {Map<string, object>} */
  const byId = new Map();
  let cursor = 0;
  let total = null;

  for (;;) {
    const url = new URL(API);
    url.searchParams.set("limit", String(LIMIT));
    url.searchParams.set("seed", String(SEED));
    if (cursor) url.searchParams.set("cursor", String(cursor));

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Krea API ${res.status} ${res.statusText} for ${url}`);
    }
    const body = await res.json();
    total = body.total ?? total;
    for (const item of body.items ?? []) {
      if (item?.id) byId.set(item.id, item);
    }
    console.log(`crawled ${byId.size}/${total ?? "?"}`);

    const next = body.nextCursor;
    if (next == null || next === "" || next === cursor) break;
    cursor = next;
    await sleep(PAGE_DELAY_MS);
  }

  return { items: [...byId.values()], total: total ?? byId.size };
}

function buildCatalog(items) {
  const sorted = [...items].sort((a, b) => {
    const ca = a.createdAt ?? "";
    const cb = b.createdAt ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });

  /** @type {Map<string, number>} */
  const seen = new Map();
  const boards = [];

  for (const item of sorted) {
    const base = toSlug(item.name ?? "moodboard");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const slug = n === 1 ? base : `${base}-${n}`;

    const previewSources = (item.previewImages ?? [])
      .slice(0, 4)
      .map((p) => p?.url)
      .filter(Boolean);

    boards.push({
      id: item.id,
      slug,
      name: item.name ?? "",
      keywords: Array.isArray(item.styleKeywords) ? item.styleKeywords : [],
      profile: item.styleDescription ?? "",
      isStaffPick: Boolean(item.isStaffPick),
      createdAt: item.createdAt ?? null,
      previews: previewSources.map((u) => toCdnPreviewUrl(u)),
    });
  }

  return boards;
}

async function main() {
  console.log("Fetching Krea preset moodboards…");
  const { items, total } = await crawlAll();
  const boards = buildCatalog(items);

  const catalog = {
    fetchedAt: new Date().toISOString(),
    source: API,
    total: boards.length,
    apiTotal: total,
    boards,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(catalog)}\n`, "utf8");
  console.log(`Wrote ${boards.length} boards → ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
