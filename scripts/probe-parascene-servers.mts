/**
 * One-shot probe for Parascene product server capabilities.
 * Reads OAuth session from the local catalog DB (debug auth store) and calls
 * GET https://api.parascene.com/api/servers (+ per-server paths).
 *
 * Usage: npx tsx scripts/probe-parascene-servers.mts
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API_BASE = "https://api.parascene.com";
const CATALOG_DB = path.join(
  os.homedir(),
  "Movies",
  "Parascene",
  "Library",
  "catalog.sqlite",
);
const OUT_PATH = path.join(
  import.meta.dirname,
  "..",
  "docs",
  "parascene-product-server-caps.json",
);

type Json = Record<string, unknown>;

function loadAccessToken(): string {
  if (!fs.existsSync(CATALOG_DB)) {
    throw new Error(`Catalog DB not found at ${CATALOG_DB}`);
  }
  const raw = execFileSync(
    "/usr/bin/sqlite3",
    [
      CATALOG_DB,
      "SELECT value FROM sync_meta WHERE key = 'auth_store:parascene_session' LIMIT 1;",
    ],
    { encoding: "utf8" },
  ).trim();
  if (!raw) {
    throw new Error(
      "No parascene_session in catalog DB — sign in via the app first",
    );
  }
  const session = JSON.parse(raw) as { accessToken?: string };
  const token = session.accessToken?.trim();
  if (!token) throw new Error("Session JSON missing accessToken");
  return token;
}

async function fetchJson(url: string, token: string): Promise<Json | null> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`ERR ${res.status} ${url}: ${text.slice(0, 200)}`);
    return null;
  }
  try {
    return JSON.parse(text) as Json;
  } catch {
    console.error(`Invalid JSON from ${url}`);
    return null;
  }
}

async function main() {
  const token = loadAccessToken();
  const paths = [
    "/api/servers",
    "/api/servers/1",
    "/api/servers/6",
    "/api/servers?ids=1,6",
  ];
  const results: Record<string, Json | null> = {};
  for (const p of paths) {
    const url = `${API_BASE}${p}`;
    console.log("GET", url);
    results[p] = await fetchJson(url, token);
  }

  const primary = results["/api/servers"] ?? results["/api/servers?ids=1,6"];
  if (!primary) {
    console.error(
      "Could not fetch server capabilities — refresh OAuth in the app and retry.",
    );
    process.exit(1);
  }

  const payload = {
    _meta: {
      endpoint: "GET https://api.parascene.com/api/servers",
      refreshed_at: new Date().toISOString().slice(0, 10),
      probe_paths: paths,
    },
    ...primary,
  };
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log("Wrote", OUT_PATH);
}

void main();
