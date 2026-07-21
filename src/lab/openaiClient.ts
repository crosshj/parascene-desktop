/** OpenAI helper for Lab — API key is set in app Settings (account menu). */

import { notifyOpenAiKeyChanged } from "../settings/events";

const OPENAI_KEY_STORAGE = "parascene.lab.openaiApiKey";

export function loadOpenAiApiKey(): string {
  try {
    return localStorage.getItem(OPENAI_KEY_STORAGE)?.trim() || "";
  } catch {
    return "";
  }
}

export function saveOpenAiApiKey(key: string): void {
  try {
    if (key.trim()) localStorage.setItem(OPENAI_KEY_STORAGE, key.trim());
    else localStorage.removeItem(OPENAI_KEY_STORAGE);
  } catch {
    /* ignore */
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
