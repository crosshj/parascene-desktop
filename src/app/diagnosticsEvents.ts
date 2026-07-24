/** App-wide UI diagnostics events (account menu, Help menu, shortcuts). */

export const OPEN_UI_DIAGNOSTICS_EVENT = "parascene:open-ui-diagnostics";
export const UNLOCK_UI_EVENT = "parascene:unlock-ui";

export function requestOpenUiDiagnostics(): void {
  window.dispatchEvent(new CustomEvent(OPEN_UI_DIAGNOSTICS_EVENT));
}

export function requestUnlockUi(): void {
  window.dispatchEvent(new CustomEvent(UNLOCK_UI_EVENT));
}
