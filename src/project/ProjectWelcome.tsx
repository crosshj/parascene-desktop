import { useState } from "react";
import { useShell } from "../app/ShellProvider";

export function ProjectWelcome() {
  const { recentProjects, openProject, createProject } = useShell();
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [slowOpeningProjectId, setSlowOpeningProjectId] = useState<string | null>(
    null,
  );

  const handleOpenProject = async (id: string) => {
    setOpeningProjectId(id);
    const slowTimer = window.setTimeout(() => {
      setSlowOpeningProjectId(id);
    }, 2000);
    try {
      await openProject(id);
    } finally {
      window.clearTimeout(slowTimer);
      setOpeningProjectId(null);
      setSlowOpeningProjectId(null);
    }
  };

  return (
    <div className="project-welcome" aria-label="Project picker">
      <div className="project-welcome-inner">
        <h1>Projects</h1>
        <p className="muted">
          Open a recent project or start a new one. Editing modes appear after a
          project is loaded.
        </p>

        <div className="project-welcome-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => createProject("Untitled project")}
          >
            New project
          </button>
        </div>

        <section aria-label="Recent projects">
          <h2 className="project-welcome-heading">Recent</h2>
          {recentProjects.length === 0 ? (
            <p className="muted">No recent projects yet.</p>
          ) : (
            <ul className="recent-project-list">
              {recentProjects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`recent-project-btn${
                      slowOpeningProjectId === p.id ? " is-opening-slow" : ""
                    }`}
                    aria-busy={openingProjectId === p.id}
                    disabled={openingProjectId !== null}
                    onClick={() => void handleOpenProject(p.id)}
                  >
                    {p.title}
                    {p.lifecycle === "provisioning" ||
                    p.lifecycle === "repair-needed" ? (
                      <span className="muted"> · Retry setup</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
