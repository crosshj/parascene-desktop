/** App-wide update check events (Help menu, account menu). */

export const CHECK_UPDATES_EVENT = "parascene:check-updates-ui";

export function requestCheckUpdates(): void {
  window.dispatchEvent(new CustomEvent(CHECK_UPDATES_EVENT));
}
