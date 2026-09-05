import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
  return agentJson<AgentInvokeBody<T>>(manifest, "/agent/v1/invoke", {
    method: "POST",
    body: JSON.stringify({ action, args }),
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
