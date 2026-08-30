/**
 * Probe the Parascene CDN appendage on Blue (not /api/files).
 *
 * Mint uses the CDN API key (and CF Access, if mint is still behind it).
 * PUT and GET of ephemeral links must work with no Bearer and no CF certs.
 *
 * Usage:
 *   npx tsx scripts/probe-blue-cdn.mts
 *
 * Env:
 *   BLUE_CDN_BASE                 default https://blue.parascene.com
 *   PARASCENE_BLUE_TOKEN          same bearer as GET /api (PARASCENE_API_KEY on Blue)
 *   PARASCENE_BLUE_CF_ACCESS_CLIENT_ID / SECRET   mint only
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.env.BLUE_CDN_BASE || "https://blue.parascene.com").replace(
  /\/$/,
  "",
);
const MINT_KEY = process.env.PARASCENE_BLUE_TOKEN?.trim() || "";

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

function makeToneWav(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blue-cdn-"));
  const out = path.join(dir, "tone.wav");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-c:a",
      "pcm_s16le",
      out,
    ],
    { stdio: "ignore" },
  );
  return out;
}

function mediaDuration(filePath: string): number {
  try {
    const raw = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        filePath,
      ],
      { encoding: "utf8" },
    ).trim();
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  } catch {
    // evermeet ffmpeg builds often ship without ffprobe
  }
  const probed = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", filePath, "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const blob = `${probed.stderr || ""}\n${probed.stdout || ""}`;
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(blob);
  if (!m) throw new Error(`could not read duration: ${blob.slice(0, 300)}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function main() {
  if (!MINT_KEY) {
    throw new Error("Set PARASCENE_BLUE_TOKEN (same key as Blue /api) for mint.");
  }
  console.log(`base ${BASE}`);

  const mintRes = await fetch(`${BASE}/cdn/uploads`, {
    method: "POST",
    headers: mintHeaders(),
    body: JSON.stringify({
      pin: true,
      content_type: "audio/wav",
      filename: "tone.wav",
    }),
  });
  const mintText = await mintRes.text();
  if (!mintRes.ok) {
    throw new Error(`mint upload URL ${mintRes.status}: ${mintText.slice(0, 300)}`);
  }
  const mint = JSON.parse(mintText) as {
    object_id: string;
    upload_url: string;
  };
  console.log(`object ${mint.object_id}`);
  console.log(`upload ${mint.upload_url}`);
  if (mint.upload_url.includes("/api/files")) {
    throw new Error("upload_url is /api/files — wrong door");
  }

  const wavPath = makeToneWav();
  const wav = fs.readFileSync(wavPath);
  const putRes = await fetch(mint.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
  });
  const putText = await putRes.text();
  if (!putRes.ok) {
    throw new Error(
      `unauthed PUT ${putRes.status}: ${putText.slice(0, 300)} (CF Access bypass for PUT /cdn/u/*?)`,
    );
  }
  console.log(`put ${putRes.status} ${putText}`);

  const denied = await fetch(`${BASE}/cdn/${mint.object_id}`);
  if (denied.status !== 403) {
    throw new Error(
      `object id GET expected 403, got ${denied.status} ${await denied.text()}`,
    );
  }
  console.log("object id GET 403 ok");

  const linkRes = await fetch(`${BASE}/cdn/objects/${mint.object_id}/links`, {
    method: "POST",
    headers: mintHeaders(),
    body: JSON.stringify({ so: 1, du: 1 }),
  });
  const linkText = await linkRes.text();
  if (!linkRes.ok) {
    throw new Error(`mint link ${linkRes.status}: ${linkText.slice(0, 300)}`);
  }
  const link = JSON.parse(linkText) as { url: string; expires_at: string };
  console.log(`fetch ${link.url}`);
  if (link.url.includes("/api/files")) {
    throw new Error("fetch url is /api/files — wrong door");
  }

  const getRes = await fetch(link.url);
  if (!getRes.ok) {
    throw new Error(
      `unauthed GET ${getRes.status}: ${(await getRes.text()).slice(0, 300)} (CF Access bypass for GET /cdn/*?)`,
    );
  }
  const clipPath = path.join(path.dirname(wavPath), "clip.bin");
  fs.writeFileSync(clipPath, Buffer.from(await getRes.arrayBuffer()));
  const dur = mediaDuration(clipPath);
  console.log(`window duration ${dur.toFixed(2)}s`);
  if (dur < 0.7 || dur > 1.5) {
    throw new Error(`expected ~1s window, got ${dur}`);
  }

  const coverNone = await fetch(
    `${link.url}${link.url.includes("?") ? "&" : "?"}cover=1`,
  );
  if (coverNone.status !== 404) {
    throw new Error(
      `cover=1 on sine expected 404, got ${coverNone.status} ${await coverNone.text()}`,
    );
  }
  console.log("cover=1 without art 404 ok");

  const jpg = path.join(path.dirname(wavPath), "art.jpg");
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", jpg],
    { stdio: "ignore" },
  );
  const withArt = path.join(path.dirname(wavPath), "with-art.mp3");
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-i",
        jpg,
        "-map",
        "0:a",
        "-map",
        "1:v",
        "-c:a",
        "libmp3lame",
        "-c:v",
        "mjpeg",
        "-disposition:v",
        "attached_pic",
        "-id3v2_version",
        "3",
        withArt,
      ],
      { stdio: "ignore" },
    );
  } catch {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-i",
        jpg,
        "-map",
        "0:a",
        "-map",
        "1:v",
        "-c:a",
        "aac",
        "-c:v",
        "mjpeg",
        "-shortest",
        withArt,
      ],
      { stdio: "ignore" },
    );
  }
  const mint2 = await fetch(`${BASE}/cdn/uploads`, {
    method: "POST",
    headers: mintHeaders(),
    body: JSON.stringify({ pin: true, content_type: "audio/mpeg" }),
  });
  const mint2Json = JSON.parse(await mint2.text()) as {
    object_id: string;
    upload_url: string;
  };
  await fetch(mint2Json.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "audio/mpeg" },
    body: fs.readFileSync(withArt),
  });
  const link2Res = await fetch(
    `${BASE}/cdn/objects/${mint2Json.object_id}/links`,
    {
      method: "POST",
      headers: mintHeaders(),
      body: JSON.stringify({}),
    },
  );
  const link2 = JSON.parse(await link2Res.text()) as { url: string };
  const coverRes = await fetch(`${link2.url}${link2.url.includes("?") ? "&" : "?"}cover=1`);
  if (!coverRes.ok) {
    throw new Error(`cover=1 with art ${coverRes.status}: ${(await coverRes.text()).slice(0, 200)}`);
  }
  const ct = coverRes.headers.get("content-type") || "";
  if (!ct.includes("image/jpeg")) {
    throw new Error(`cover=1 expected image/jpeg, got ${ct}`);
  }
  console.log(`cover=1 ${coverRes.status} ${ct} ${Number(coverRes.headers.get("content-length") || 0)}b`);

  await fetch(`${BASE}/cdn/objects/${mint.object_id}`, {
    method: "DELETE",
    headers: mintHeaders(),
  });
  await fetch(`${BASE}/cdn/objects/${mint2Json.object_id}`, {
    method: "DELETE",
    headers: mintHeaders(),
  });

  console.log("ok");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
