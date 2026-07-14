import { useShell } from "../../app/ShellProvider";
import { llmAssistantStub } from "../../capabilities";

export function EditorLayout() {
  const {
    project,
    leftCollapsed,
    rightCollapsed,
    toggleLeft,
    toggleRight,
  } = useShell();

  return (
    <div className="layout editor">
      {!leftCollapsed ? (
        <aside className="panel left" aria-label="Assets">
          <div className="panel-head">
            <h2>Assets</h2>
            <button type="button" className="btn ghost" onClick={toggleLeft}>
              Collapse
            </button>
          </div>
          <ul className="asset-list">
            {project.assets.map((asset) => (
              <li key={asset.id}>
                <span>{asset.name}</span>
                <span className="muted">{asset.kind}</span>
              </li>
            ))}
          </ul>
        </aside>
      ) : (
        <button type="button" className="panel-expand left" onClick={toggleLeft}>
          Assets
        </button>
      )}

      <section className="editor-center">
        <div className="preview-placeholder">Preview</div>
        <div className="timeline" aria-label="Timeline">
          {project.timeline.map((clip) => (
            <div
              key={clip.id}
              className="timeline-clip"
              style={{
                flexGrow: Math.max(1, clip.endSec - clip.startSec),
              }}
            >
              {clip.label}
            </div>
          ))}
        </div>
      </section>

      {!rightCollapsed ? (
        <aside className="panel right" aria-label="Assistant">
          <div className="panel-head">
            <h2>Assistant</h2>
            <button type="button" className="btn ghost" onClick={toggleRight}>
              Collapse
            </button>
          </div>
          <p className="muted">Ask for edits or shot ideas (stub).</p>
          <button
            type="button"
            className="btn"
            onClick={() => llmAssistantStub.ask("placeholder")}
          >
            Ask (unimplemented)
          </button>
        </aside>
      ) : (
        <button
          type="button"
          className="panel-expand right"
          onClick={toggleRight}
        >
          Assistant
        </button>
      )}
    </div>
  );
}
