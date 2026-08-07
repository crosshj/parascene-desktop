import { useState } from "react";
import { useShell } from "../app/ShellProvider";
import { useConfirm } from "../ui/ConfirmDialog";
import { isTrulyLegacyProject } from "./projectStore";

function projectChooserAnnotation(project: {
  lifecycle: "provisioning" | "ready" | "repair-needed" | "legacy" | undefined;
  folderSetupIssue: "blocked" | null | undefined;
  documentCorrupt: boolean;
}): string | null {
  if (project.documentCorrupt) return "Needs repair";
  if (project.folderSetupIssue === "blocked") return "Needs folder";
  if (project.lifecycle === "legacy") return "Legacy";
  if (
    project.lifecycle === "provisioning" ||
    project.lifecycle === "repair-needed"
  ) {
    return "Retry setup";
  }
  if (project.lifecycle == null) return "Legacy";
  return null;
}

export function ProjectWelcome() {
  const {
    recentProjects,
    openProject,
    createProject,
    deleteProject,
    folderSetupProgress,
  } = useShell();
  const confirm = useConfirm();
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(
    null,
  );
  const [creating, setCreating] = useState(false);

  const handleOpenProject = async (
    id: string,
    options?: { asLegacy?: boolean },
  ) => {
    setOpeningProjectId(id);
    try {
      await openProject(id, true, options);
    } finally {
      setOpeningProjectId(null);
    }
  };

  const handleCreateProject = async () => {
    setCreating(true);
    try {
      await createProject("Untitled project");
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteProject = async (id: string, title: string) => {
    const label = title.trim() || "Untitled project";
    await confirm({
      title: `Delete “${label}”?`,
      message:
        "This removes the project from this device. Library media files are kept. If the project has a folder, that folder is removed and its files return to Library root (they are not deleted).",
      confirmLabel: "Delete project",
      danger: true,
      errorTitle: "Could not delete project",
      onConfirm: async () => {
        setDeletingProjectId(id);
        try {
          await deleteProject(id);
        } finally {
          setDeletingProjectId(null);
        }
      },
    });
  };

  const busy =
    openingProjectId !== null ||
    deletingProjectId !== null ||
    creating ||
    folderSetupProgress !== null;

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
            disabled={busy}
            onClick={() => void handleCreateProject()}
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
              {recentProjects.map((p) => {
                const issue = projectChooserAnnotation(p);
                const trulyLegacy = isTrulyLegacyProject(p);
                const showLegacyOpen =
                  trulyLegacy && p.lifecycle !== "legacy" && !p.documentCorrupt;
                return (
                  <li key={p.id} className="recent-project-row">
                    <button
                      type="button"
                      className={`recent-project-btn${
                        issue ? " has-folder-issue" : ""
                      }`}
                      disabled={busy}
                      title={
                        issue === "Needs repair"
                          ? "This project’s saved document is corrupt. Open to repair malformed timeline clips."
                          : issue === "Needs folder"
                            ? "Project files are split across folders. Open to fix or gather them into one folder."
                            : issue === "Retry setup"
                              ? "Project folder setup did not finish. Open to retry."
                              : issue === "Legacy"
                                ? p.lifecycle === "legacy"
                                  ? "Opens without a project folder (intentional legacy)."
                                  : "Pre–project-folder document. Open migrates into a folder when possible; use Open as legacy to skip."
                                : undefined
                      }
                      onClick={() => void handleOpenProject(p.id)}
                    >
                      {p.title}
                      {issue ? (
                        <span className="recent-project-issue"> · {issue}</span>
                      ) : null}
                    </button>
                    {showLegacyOpen ? (
                      <button
                        type="button"
                        className="btn ghost recent-project-legacy-btn"
                        disabled={busy}
                        title="Open without creating or assigning a project folder"
                        onClick={() =>
                          void handleOpenProject(p.id, { asLegacy: true })
                        }
                      >
                        Open as legacy
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn ghost recent-project-delete-btn"
                      disabled={busy}
                      title="Delete this project (keeps Library media)"
                      onClick={() => void handleDeleteProject(p.id, p.title)}
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
