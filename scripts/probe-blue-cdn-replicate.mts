/**
 * Phase 2: prove Replicate can GET a Blue CDN window URL.
 *
 * Cheap on purpose: openai/whisper (~$0.0025), not a video A2V model.
 * Success = prediction succeeded (worker fetched the unauthed /cdn URL).
 *
 * Usage:
 *   npx tsx scripts/probe-blue-cdn-replicate.mts
 *
 * Env: same Blue mint vars as probe-blue-cdn.mts, plus
 *   REPLICATE_API_TOKEN   (or catalog keychain via the runner)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.env.BLUE_CDN_BASE || "https://blue.parascene.com").replace(
  /\/$/,
  "",
);
const MINT_KEY = process.env.PARASCENE_BLUE_TOKEN?.trim() || "";
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN?.trim() || "";

function mintHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${MINT_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const id = process.env.PARASCENE_BLUE_CF_ACCESS_CLIENT_ID?.trim();
  const secret = process.env.PARASCENE_BLUE_CF_ACCESS_CLIENT_SECRET?.trim();
  if (id) headers["CF-Access-Client-Id"] = id;
  if (secret) headers["CF-Access-Client-Secret"] = secret;
  return headers;
}

function makeSpeechWav(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blue-cdn-rep-"));
  const aiff = path.join(dir, "speech.aiff");
  const wav = path.join(dir, "speech.wav");
  execFileSync("say", ["-o", aiff, "hello from parascene blue cdn"], {
    stdio: "ignore",
  });
  execFileSync(
    "ffmpeg",
    ["-y", "-i", aiff, "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", wav],
    { stdio: "ignore" },
  );
  return wav;
}

function fetchErrorHint(text: string): string | null {
  const t = text.toLowerCase();
  if (
    t.includes("error 1010") ||
    t.includes("cloudflare") ||
    t.includes("access denied") ||
    t.includes("cf-access") ||
    t.includes("401") ||
    t.includes("403") ||
    t.includes("could not download") ||
    t.includes("failed to download") ||
    t.includes("timed out")
  ) {
    return text.slice(0, 400);
  }
  return null;
}

async function waitPrediction(getUrl: string): Promise<Record<string, unknown>> {
  const headers = {
    Authorization: `Bearer ${REPLICATE_TOKEN}`,
    Accept: "application/json",
  };
  for (let i = 0; i < 60; i += 1) {
    const res = await fetch(getUrl, { headers });
    const json = (await res.json()) as Record<string, unknown>;
    const status = String(json.status || "");
    if (status === "succeeded" || status === "failed" || status === "canceled") {
      return json;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Replicate prediction timed out waiting for a terminal status.");
}

async function main() {
  if (!MINT_KEY) throw new Error("Set PARASCENE_BLUE_TOKEN for CDN mint.");
  if (!REPLICATE_TOKEN) throw new Error("Set REPLICATE_API_TOKEN.");

  const wavPath = makeSpeechWav();
  const wav = fs.readFileSync(wavPath);

  const mintRes = await fetch(`${BASE}/cdn/uploads`, {
    method: "POST",
    headers: mintHeaders(),
    body: JSON.stringify({
      pin: true,
      content_type: "audio/wav",
      filename: "speech.wav",
    }),
  });
  const mintText = await mintRes.text();
  if (!mintRes.ok) {
    throw new Error(`mint ${mintRes.status}: ${mintText.slice(0, 300)}`);
  }
  const mint = JSON.parse(mintText) as { object_id: string; upload_url: string };
  console.log(`object ${mint.object_id}`);

  const putRes = await fetch(mint.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
  });
  if (!putRes.ok) {
    throw new Error(`PUT ${putRes.status}: ${(await putRes.text()).slice(0, 300)}`);
  }

  const linkRes = await fetch(`${BASE}/cdn/objects/${mint.object_id}/links`, {
    method: "POST",
    headers: mintHeaders(),
    body: JSON.stringify({ so: 0, du: 3 }),
  });
  const linkText = await linkRes.text();
  if (!linkRes.ok) {
    throw new Error(`link ${linkRes.status}: ${linkText.slice(0, 300)}`);
  }
  const link = JSON.parse(linkText) as { url: string };
  console.log(`cdn ${link.url}`);
  if (link.url.includes("/api/files")) {
    throw new Error("CDN url is /api/files — wrong door");
  }

  const modelRes = await fetch("https://api.replicate.com/v1/models/openai/whisper", {
    headers: {
      Authorization: `Bearer ${REPLICATE_TOKEN}`,
      Accept: "application/json",
    },
  });
  const model = (await modelRes.json()) as {
    latest_version?: { id?: string };
  };
  const version = model.latest_version?.id;
  if (!modelRes.ok || !version) {
    throw new Error(`whisper model lookup ${modelRes.status}`);
  }

  const predRes = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REPLICATE_TOKEN}`,
      "Content-Type": "application/json",
      Prefer: "wait=10",
    },
    body: JSON.stringify({
      version,
      input: { audio: link.url, language: "en" },
    }),
  });
  const predText = await predRes.text();
  if (!predRes.ok) {
    throw new Error(`replicate create ${predRes.status}: ${predText.slice(0, 400)}`);
  }
  let pred = JSON.parse(predText) as Record<string, unknown>;
  const getUrl =
    (pred.urls as { get?: string } | undefined)?.get ||
    `https://api.replicate.com/v1/predictions/${pred.id}`;
  console.log(`prediction ${pred.id} status=${pred.status}`);
  if (pred.status !== "succeeded" && pred.status !== "failed") {
    pred = await waitPrediction(getUrl);
  }
  console.log(`status ${pred.status}`);

  const blob = JSON.stringify(pred);
  const hint = fetchErrorHint(blob);
  if (pred.status !== "succeeded") {
    throw new Error(
      `replicate ${pred.status}: ${hint || blob.slice(0, 500)}`,
    );
  }
  if (hint) {
    throw new Error(`replicate succeeded but fetch looks broken: ${hint}`);
  }

  const output = pred.output as { transcription?: string } | string | null;
  const text =
    typeof output === "string"
      ? output
      : output && typeof output === "object"
        ? String(output.transcription || JSON.stringify(output)).slice(0, 200)
        : "";
  console.log(`whisper ${text || "(empty transcription, fetch still succeeded)"}`);

  const del = await fetch(`${BASE}/cdn/objects/${mint.object_id}`, {
    method: "DELETE",
    headers: mintHeaders(),
  });
  console.log(`delete ${del.status}`);
  console.log("ok");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
