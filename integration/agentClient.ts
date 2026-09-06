import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Grok / LTX can sit quiet past Node fetch's 5-minute header timeout. */
const INVOKE_TIMEOUT_MS = 13 * 60_000;

export type AgentManifest = {
  origin: string;
  token: string;
  pid: number;
};

export async function loadAgentManifest(): Promise<AgentManifest> {
  const candidates = [
    join(homedir(), "Movies", "Parascene", "agent.json"),
    join(homedir(), "Videos", "Parascene", "agent.json"),
  ];
  let last = "";
  for (const path of candidates) {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as AgentManifest;
      if (!parsed.origin || !parsed.token) {
        throw new Error(`${path} is missing origin or token`);
      }
      return parsed;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(
    `Agent API is not up (${last}). Start the desktop app with npm run dev, then retry.`,
  );
}

export async function agentFetch(
  manifest: AgentManifest,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${manifest.token}`);
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${manifest.origin}${path}`, { ...init, headers });
}

export async function agentJson<T>(
  manifest: AgentManifest,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await agentFetch(manifest, path, init);
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

export type AgentInvokeBody<T = unknown> = {
  ok?: boolean;
  result?: T;
  error?: string;
};

export async function agentInvoke<T = unknown>(
  manifest: AgentManifest,
  action: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; body: AgentInvokeBody<T> }> {
  const url = new URL("/agent/v1/invoke", manifest.origin);
  const payload = JSON.stringify({ action, args });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${manifest.token}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(payload)),
        },
        timeout: INVOKE_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as AgentInvokeBody<T>,
            });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`${action} timed out after ${INVOKE_TIMEOUT_MS / 1000}s`));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export async function requireSignedIn(agent: AgentManifest): Promise<void> {
  const { status, body } = await agentJson<{ status?: string }>(
    agent,
    "/agent/v1/state?scope=auth",
  );
  if (status !== 200 || body.status !== "connected") {
    throw new Error(
      `Not signed in (auth.status=${body.status ?? "missing"}). Sign in on the running app, then retry.`,
    );
  }
}

export async function invokeOk<T>(
  agent: AgentManifest,
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { status, body } = await agentInvoke<T>(agent, action, args);
  if (status !== 200 || !body.ok) {
    throw new Error(body.error || `${action} failed (${status})`);
  }
  return body.result as T;
}
