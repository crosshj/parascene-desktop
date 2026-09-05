import { useEffect } from "react";
import { openHelpWindow } from "./openHelpWindow";

export function useHelpShortcut() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F1") {
        event.preventDefault();
        void openHelpWindow();
        return;
      }
      if (event.key !== "?" && event.key !== "/") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.closest("input, textarea, select, [contenteditable='true']") ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "/" && !event.shiftKey) return;
      event.preventDefault();
      void openHelpWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
