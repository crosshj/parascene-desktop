import { invoke } from "@tauri-apps/api/core";

/** Copy text via native clipboard (preferred) or DOM fallbacks. */
export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await invoke("clipboard_write_text", { text });
    return;
  } catch {
    // Browser / non-Tauri / command unavailable — try Web APIs.
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through — WKWebView often denies after async gaps.
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "-9999px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
  if (!ok) {
    throw new Error("Copy was rejected by the platform");
  }
}
