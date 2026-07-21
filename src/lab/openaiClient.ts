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

/** Starter shot catalog for storyboard propose smoke. */
export const LAB_SHOT_CATALOG = [
  "lip_sync_cu",
  "lip_sync_mcu",
  "wide_performance",
  "instrument_detail",
  "metaphor_broll",
  "location_plate",
  "lyric_card",
  "crowd_energy",
  "push_in",
  "static_hold",
  "chorus_punch",
  "bridge_reset",
  "outro_hold",
] as const;
