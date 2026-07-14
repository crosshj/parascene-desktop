import { useShell } from "../../app/ShellProvider";

export function DirectorLayout() {
  const { project, selectedSceneId, setSelectedSceneId } = useShell();

  return (
    <div className="layout director">
      <section className="preview-pane" aria-label="Video preview">
        <div className="preview-placeholder">Preview</div>
      </section>
      <aside className="director-side">
        <h2>Scenes</h2>
        <ul className="scene-list">
          {project.scenes.map((scene) => (
            <li key={scene.id}>
              <button
                type="button"
                className={
                  selectedSceneId === scene.id ? "scene-item active" : "scene-item"
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
      </aside>
    </div>
  );
}
