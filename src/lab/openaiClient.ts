/** OpenAI helper for Lab — API key lives in the OS keychain (Settings). */

import { invoke } from "@tauri-apps/api/core";
import { notifyOpenAiKeyChanged } from "../settings/events";

const OPENAI_KEYCHAIN_KEY = "parascene_openai_api_key";
const LEGACY_OPENAI_KEY_STORAGE = "parascene.lab.openaiApiKey";

let cachedKey = "";
let hydrated = false;

async function keychainGet(key: string): Promise<string | null> {
  try {
    return await invoke<string | null>("keychain_get", { key });
  } catch {
    return null;
  }
}

async function keychainSet(key: string, value: string): Promise<void> {
  await invoke("keychain_set", { key, value });
}

async function keychainDelete(key: string): Promise<void> {
  try {
    await invoke("keychain_delete", { key });
  } catch {
    /* ignore */
  }
}

/** Load keychain (and one-time localStorage migrate). Call at app start. */
export async function hydrateOpenAiApiKey(): Promise<string> {
  try {
    const fromChain = (await keychainGet(OPENAI_KEYCHAIN_KEY))?.trim() || "";
    if (fromChain) {
      cachedKey = fromChain;
      hydrated = true;
      try {
        localStorage.removeItem(LEGACY_OPENAI_KEY_STORAGE);
      } catch {
        /* ignore */
      }
      return cachedKey;
    }
    let legacy = "";
    try {
      legacy = localStorage.getItem(LEGACY_OPENAI_KEY_STORAGE)?.trim() || "";
    } catch {
      legacy = "";
    }
    if (legacy) {
      await keychainSet(OPENAI_KEYCHAIN_KEY, legacy);
      try {
        localStorage.removeItem(LEGACY_OPENAI_KEY_STORAGE);
      } catch {
        /* ignore */
      }
      cachedKey = legacy;
    } else {
      cachedKey = "";
    }
  } catch {
    cachedKey = "";
  }
  hydrated = true;
  return cachedKey;
}

/** Sync read of the in-memory cache (hydrate first at startup). */
export function loadOpenAiApiKey(): string {
  if (!hydrated) {
    try {
      return localStorage.getItem(LEGACY_OPENAI_KEY_STORAGE)?.trim() || cachedKey;
    } catch {
      return cachedKey;
    }
  }
  return cachedKey;
}

export async function saveOpenAiApiKey(key: string): Promise<void> {
  const next = key.trim();
  try {
    if (next) await keychainSet(OPENAI_KEYCHAIN_KEY, next);
    else await keychainDelete(OPENAI_KEYCHAIN_KEY);
    try {
      localStorage.removeItem(LEGACY_OPENAI_KEY_STORAGE);
    } catch {
      /* ignore */
    }
    cachedKey = next;
    hydrated = true;
  } catch {
    /* fall back to legacy store if keychain fails */
    try {
      if (next) localStorage.setItem(LEGACY_OPENAI_KEY_STORAGE, next);
      else localStorage.removeItem(LEGACY_OPENAI_KEY_STORAGE);
      cachedKey = next;
    } catch {
      /* ignore */
    }
  }
  notifyOpenAiKeyChanged();
}

export function hasOpenAiApiKey(): boolean {
  return Boolean(loadOpenAiApiKey());
}

/** Stronger model for lyric ↔ Whisper word-range alignment. */
export const OPENAI_LYRIC_ALIGN_MODEL = "gpt-4.1";

/** Stronger model for MV storyboard planning. */
export const OPENAI_STORYBOARD_MODEL = "gpt-4.1";

export type OpenAiChatResult = {
  request: Record<string, unknown>;
  response: unknown;
  content: string;
};

export async function openAiChatCompletion(opts: {
  apiKey: string;
  model?: string;
  system?: string;
  user: string;
  jsonMode?: boolean;
  temperature?: number;
}): Promise<OpenAiChatResult> {
  const model = opts.model?.trim() || "gpt-4o-mini";
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system?.trim()) {
    messages.push({ role: "system", content: opts.system.trim() });
  }
  messages.push({ role: "user", content: opts.user });

  const request: Record<string, unknown> = {
    model,
    messages,
  };
  if (opts.jsonMode) {
    request.response_format = { type: "json_object" };
  }
  if (opts.temperature !== undefined) {
    request.temperature = opts.temperature;
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const response = (await res.json()) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!res.ok) {
    throw new Error(
      response.error?.message || `OpenAI HTTP ${res.status}`,
    );
  }
  const content = response.choices?.[0]?.message?.content?.trim() || "";
  return { request, response, content };
}

/** @deprecated Use STORYBOARD_SHOT_TYPES from storyboardShotCatalog */
export { STORYBOARD_SHOT_TYPES as LAB_SHOT_CATALOG } from "./storyboardShotCatalog";
