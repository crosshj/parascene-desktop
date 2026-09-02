/**
 * One-shot probe for Parascene Blue GET /api capabilities.
 * Reads Blue creds from the local catalog DB (debug auth store) or env.
 *
 * Usage: npx tsx scripts/probe-blue-api.mts
 *
 * Env fallback (when Settings/catalog is empty):
 *   PARASCENE_BLUE_TOKEN
 *   PARASCENE_BLUE_CF_ACCESS_CLIENT_ID
 *   PARASCENE_BLUE_CF_ACCESS_CLIENT_SECRET
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BLUE_BASE = "https://blue.parascene.com";
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
  "parascene-blue-api-capabilities.json",
);

type BlueCreds = {
  token: string;
  cfAccessClientId: string;
  cfAccessClientSecret: string;
};

function loadCredsFromCatalog(): BlueCreds | null {
  if (!fs.existsSync(CATALOG_DB)) return null;
  const raw = execFileSync(
    "/usr/bin/sqlite3",
    [
      CATALOG_DB,
      "SELECT value FROM sync_meta WHERE key = 'auth_store:blue_provider_credentials' LIMIT 1;",
    ],
    { encoding: "utf8" },
  ).trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<BlueCreds>;
  const token = parsed.token?.trim() ?? "";
  const cfAccessClientId = parsed.cfAccessClientId?.trim() ?? "";
  const cfAccessClientSecret = parsed.cfAccessClientSecret?.trim() ?? "";
  if (!token || !cfAccessClientId || !cfAccessClientSecret) return null;
  return { token, cfAccessClientId, cfAccessClientSecret };
}

function loadCredsFromEnv(): BlueCreds | null {
  const token = process.env.PARASCENE_BLUE_TOKEN?.trim() ?? "";
  const cfAccessClientId =
    process.env.PARASCENE_BLUE_CF_ACCESS_CLIENT_ID?.trim() ?? "";
  const cfAccessClientSecret =
    process.env.PARASCENE_BLUE_CF_ACCESS_CLIENT_SECRET?.trim() ?? "";
  if (!token || !cfAccessClientId || !cfAccessClientSecret) return null;
  return { token, cfAccessClientId, cfAccessClientSecret };
}

async function main() {
  const creds = loadCredsFromCatalog() ?? loadCredsFromEnv();
  if (!creds) {
    console.error(
      "No Blue credentials — set them in Settings or PARASCENE_BLUE_* env.",
    );
    process.exit(1);
  }

  const res = await fetch(`${BLUE_BASE}/api`, {
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "CF-Access-Client-Id": creds.cfAccessClientId,
      "CF-Access-Client-Secret": creds.cfAccessClientSecret,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`ERR ${res.status} ${BLUE_BASE}/api: ${text.slice(0, 200)}`);
    process.exit(1);
  }
  const payload = JSON.parse(text) as Record<string, unknown>;
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  const methods = payload.methods as Record<string, unknown> | undefined;
  const methodIds = methods ? Object.keys(methods) : [];
  console.log("Wrote", OUT_PATH);
  console.log("methods:", methodIds.join(", ") || "(none)");
}

void main();
