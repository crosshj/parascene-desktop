//! Native clipboard — WKWebView often denies `navigator.clipboard` after awaits.

use arboard::Clipboard;

#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    Clipboard::new()
        .map_err(|e| format!("Clipboard unavailable: {e}"))?
        .set_text(text)
        .map_err(|e| format!("Clipboard write failed: {e}"))
}
