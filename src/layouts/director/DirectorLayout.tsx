import { useState } from "react";
import { useShell } from "../../app/ShellProvider";
import {
  PROJECT_ASPECT_OPTIONS,
  projectAspectCss,
  type ProjectAspectRatio,
} from "../../project/aspectRatios";
import {
  isLookEnabled,
  PROJECT_LOOK_OPTIONS,
  type ProjectLookId,
} from "../../project/looks";

export function DirectorLayout() {
  const {
    project,
    selectedSceneId,
    setSelectedSceneId,
    renameOpenProject,
    setOpenProjectAspectRatio,
    setOpenProjectLookEnabled,
    closeProject,
  } = useShell();
  const [titleDraft, setTitleDraft] = useState(project.title);
  const [syncedTitle, setSyncedTitle] = useState({
    id: project.id,
    title: project.title,
  });
  if (project.id !== syncedTitle.id || project.title !== syncedTitle.title) {
    setSyncedTitle({ id: project.id, title: project.title });
    setTitleDraft(project.title);
  }

  const commitTitle = () => {
    const next = titleDraft.trim() || "Untitled project";
    setTitleDraft(next);
    if (next !== project.title) renameOpenProject(next);
  };

  const onAspectChange = (next: ProjectAspectRatio) => {
    if (next !== project.aspectRatio) setOpenProjectAspectRatio(next);
  };

  const onLookToggle = (id: ProjectLookId) => {
    setOpenProjectLookEnabled(id, !isLookEnabled(project.looks, id));
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

        <div className="director-looks" role="radiogroup" aria-label="Project look">
          <span className="director-looks-label">Looks</span>
          <div className="director-looks-options">
            {PROJECT_LOOK_OPTIONS.map((opt) => {
              const active = isLookEnabled(project.looks, opt.id);
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  className={
                    active
                      ? "director-look-option is-active"
                      : "director-look-option"
                  }
                  aria-checked={active}
                  onClick={() => onLookToggle(opt.id)}
                  title={`${opt.label} · ${opt.sublabel}`}
                >
                  <span className="director-look-option-text">
                    <span className="director-look-option-label">
                      {opt.label}
                    </span>
                    <span className="director-look-option-sub muted">
                      {opt.sublabel}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="muted director-looks-hint">
            Applied on Publisher render only (baked into the output). GPU CRT when
            available; TV can fall back to FFmpeg. No vintage color grade.
          </p>
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
