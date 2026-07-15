import { useEffect, useState } from "react";
import { useShell } from "../../app/ShellProvider";
import {
  PROJECT_ASPECT_OPTIONS,
  projectAspectCss,
  type ProjectAspectRatio,
} from "../../project/aspectRatios";

export function DirectorLayout() {
  const {
    project,
    selectedSceneId,
    setSelectedSceneId,
    renameOpenProject,
    setOpenProjectAspectRatio,
    closeProject,
  } = useShell();
  const [titleDraft, setTitleDraft] = useState(project.title);

  useEffect(() => {
    setTitleDraft(project.title);
  }, [project.id, project.title]);

  const commitTitle = () => {
    const next = titleDraft.trim() || "Untitled project";
    setTitleDraft(next);
    if (next !== project.title) renameOpenProject(next);
  };

  const onAspectChange = (next: ProjectAspectRatio) => {
    if (next !== project.aspectRatio) setOpenProjectAspectRatio(next);
  };

  return (
    <div className="layout director">
      <section className="preview-pane" aria-label="Video preview">
        <div
          className="preview-placeholder director-preview-frame"
          style={{ aspectRatio: projectAspectCss(project.aspectRatio) }}
        >
          Preview
          <span className="muted director-preview-aspect">
            {project.aspectRatio}
          </span>
        </div>
      </section>
      <aside className="director-side">
        <label className="director-project-name">
          <span className="director-project-name-label">Project</span>
          <input
            type="text"
            className="director-project-name-input"
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                (event.target as HTMLInputElement).blur();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTitleDraft(project.title);
                (event.target as HTMLInputElement).blur();
              }
            }}
            aria-label="Project name"
            spellCheck={false}
          />
        </label>

        <div
          className="director-aspect"
          role="group"
          aria-label="Project aspect ratio"
        >
          <span className="director-aspect-label">Aspect ratio</span>
          <div className="director-aspect-options">
            {PROJECT_ASPECT_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={
                  project.aspectRatio === opt.id
                    ? "director-aspect-option is-active"
                    : "director-aspect-option"
                }
                aria-pressed={project.aspectRatio === opt.id}
                onClick={() => onAspectChange(opt.id)}
                title={`${opt.label} · ${opt.sublabel}`}
              >
                <span
                  className="director-aspect-glyph"
                  style={{ aspectRatio: `${opt.w} / ${opt.h}` }}
                  aria-hidden
                />
                <span className="director-aspect-option-text">
                  <span className="director-aspect-option-label">
                    {opt.label}
                  </span>
                  <span className="director-aspect-option-sub muted">
                    {opt.sublabel}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <h2>Scenes</h2>
        <ul className="scene-list">
          {project.scenes.map((scene) => (
            <li key={scene.id}>
              <button
                type="button"
                className={
                  selectedSceneId === scene.id
                    ? "scene-item active"
                    : "scene-item"
                }
                onClick={() => setSelectedSceneId(scene.id)}
              >
                <span>{scene.title}</span>
                <span className="muted">{scene.durationLabel}</span>
              </button>
            </li>
          ))}
        </ul>
        <label className="instruction-box">
          <span>Instruction</span>
          <textarea
            rows={4}
            placeholder="Describe what you want to happen next…"
            defaultValue=""
          />
        </label>
        <div className="sequence-strip" aria-label="Sequence">
          {project.scenes.map((scene) => (
            <span key={scene.id} className="seq-chip">
              {scene.title}
            </span>
          ))}
        </div>
        <div className="director-side-footer">
          <button
            type="button"
            className="btn director-close-project"
            onClick={() => closeProject()}
          >
            Close project
          </button>
        </div>
      </aside>
    </div>
  );
}
