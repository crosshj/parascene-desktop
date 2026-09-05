import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { resetGenerateServerCredentialCaches } from "../layouts/editor/generateServerCredentials";
import {
  clearOpenAiApiKeyCache,
  hydrateOpenAiApiKey,
} from "../lab/openaiClient";
import {
  notifyBlueCredentialsChanged,
  notifyOpenAiKeyChanged,
  notifyReplicateTokenChanged,
} from "../settings/events";

export type AccountLoginResult = {
  kind: "legacy" | "folder" | "created" | "refuse";
  userId: string;
  accountRoot: string;
  relaunch: boolean;
  message?: string;
};

export type AccountLogoutResult = {
  relaunch: boolean;
  accountRoot: string;
  userId: string;
};

export type AccountHydrate = {
  localStorage: Record<string, string>;
  present: boolean;
};

export function snapshotLocalStorage(): Record<string, string> {
  window.dispatchEvent(new Event("parascene:account-flush"));
  const out: Record<string, string> = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key) continue;
    const value = window.localStorage.getItem(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

export function applyHydrate(hydrate: AccountHydrate): void {
  if (!hydrate.present) return;
  window.localStorage.clear();
  for (const [key, value] of Object.entries(hydrate.localStorage ?? {})) {
    window.localStorage.setItem(key, value);
  }
  window.dispatchEvent(new Event("parascene:preview-quality-changed"));
  window.dispatchEvent(new Event("parascene:account-hydrated"));
}

export async function accountStartup(): Promise<void> {
  await invoke("account_startup");
}

export async function accountLogin(
  userId: string,
  allowLegacy: boolean,
): Promise<AccountLoginResult> {
  return invoke<AccountLoginResult>("account_login", {
    userId,
    allowLegacy,
  });
}

export async function accountHydrate(): Promise<AccountHydrate> {
  const raw = await invoke<{
    localStorage?: Record<string, string>;
    local_storage?: Record<string, string>;
    present?: boolean;
  }>("account_hydrate");
  const local = raw.localStorage ?? raw.local_storage ?? {};
  return {
    localStorage: local && typeof local === "object" ? local : {},
    present: Boolean(raw.present),
  };
}

export async function accountRestoreSecrets(): Promise<void> {
  await invoke("account_restore_secrets");
}

export async function accountLogout(input: {
  localStorage: Record<string, string>;
  identity: {
    sub: string;
    preferred_username?: string;
    name?: string;
    picture?: string;
  };
}): Promise<AccountLogoutResult> {
  return invoke<AccountLogoutResult>("account_logout", { request: input });
}

async function notifyAccountReady(): Promise<void> {
  resetGenerateServerCredentialCaches();
  clearOpenAiApiKeyCache();
  await hydrateOpenAiApiKey();
  notifyOpenAiKeyChanged();
  notifyReplicateTokenChanged();
  notifyBlueCredentialsChanged();
}

export async function bindAndHydrate(
  userId: string,
  allowLegacy: boolean,
): Promise<AccountLoginResult> {
  const result = await accountLogin(userId, allowLegacy);
  const hydrate = await accountHydrate();
  if (hydrate.present) {
    await accountRestoreSecrets();
    applyHydrate(hydrate);
  }
  await notifyAccountReady();
  return result;
}

export async function relaunchIfNeeded(should: boolean): Promise<void> {
  if (!should) return;
  await relaunch();
}
