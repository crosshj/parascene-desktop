import { useShell } from "../app/ShellProvider";

/** Non-blocking WIP watermark — hidden on Library surfaces and Editor. */
export function WipOverlay() {
  const { primaryTab, librarySurface, mode } = useShell();
  if (
    (primaryTab === "library" &&
      (librarySurface === "creations" || librarySurface === "sync")) ||
    (primaryTab === "project" && mode === "editor")
  ) {
    return null;
  }

  return (
    <div className="wip-overlay" aria-hidden="true">
      <div className="wip-watermark">Work In Progress</div>
    </div>
  );
}
