/** App-wide settings UI events (account menu ↔ Lab gates). */

export const OPEN_SETTINGS_EVENT = "parascene:open-settings";
export const OPENAI_KEY_CHANGED_EVENT = "parascene:openai-key-changed";

export function requestOpenSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT));
}

export function notifyOpenAiKeyChanged(): void {
  window.dispatchEvent(new CustomEvent(OPENAI_KEY_CHANGED_EVENT));
}
