import { useShell } from "../app/ShellProvider";

export function ProjectWelcome() {
  const { recentProjects, openProject, project } = useShell();

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
            onClick={() => openProject(project.id)}
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
                    className="recent-project-btn"
                    onClick={() => openProject(p.id)}
                  >
                    {p.title}
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
