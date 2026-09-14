/** Whether any language-model adapter is ready. Vendor stays in Rust. */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OPENAI_KEY_CHANGED_EVENT } from "../settings/events";
import { serviceDescribe } from "../services/serviceClient";

export async function assistantLlmConfigured(): Promise<boolean> {
  try {
    const describe = await serviceDescribe({
      service: "local",
      operation: "assistant_chat",
    });
    return describe.credentials?.configured === true;
  } catch {
    return false;
  }
}

/** Editor Assistant chrome: v2 project and a backend that can complete a turn. */
export function editorAssistantVisible(
  projectIsV2: boolean,
  llmConfigured: boolean,
): boolean {
  return projectIsV2 && llmConfigured;
}

/** Confirmed adapter credentials. False until describe says so. */
export function useAssistantLlmConfigured(): boolean {
  const [configured, setConfigured] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      void assistantLlmConfigured().then((ready) => {
        if (!cancelled) setConfigured(ready);
      });
    };
    sync();
    window.addEventListener(OPENAI_KEY_CHANGED_EVENT, sync);
    return () => {
      cancelled = true;
      window.removeEventListener(OPENAI_KEY_CHANGED_EVENT, sync);
    };
  }, []);
  return configured;
}

/** Drop the in-flight OpenAI request. The pane also ignores a late result. */
export async function cancelAssistantChat(): Promise<void> {
  try {
    await invoke("assistant_chat_cancel");
  } catch {
    // Pane generation token still drops the reply.
  }
}
