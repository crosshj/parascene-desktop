import { useShell } from "../../app/ShellProvider";
import { hookPublishingStub } from "../../capabilities";

export function HookLayout() {
  const {
    project,
    hookUrl,
    setHookUrl,
    hookRange,
    setHookRange,
  } = useShell();

  return (
    <div className="layout hook">
      <section className="hook-preview" aria-label="Hook preview">
        <div className="preview-placeholder vertical">9:16 / square preview</div>
        <label className="range-block">
          <span>
            Hook range ({hookRange.startSec}s–{hookRange.endSec}s)
          </span>
          <input
            type="range"
            min={0}
            max={30}
            value={hookRange.startSec}
            onChange={(e) =>
              setHookRange({
                startSec: Number(e.target.value),
                endSec: Math.min(30, Number(e.target.value) + 9),
              })
            }
          />
        </label>
      </section>
      <aside className="hook-side">
        <h2>Suggestions</h2>
        <ul className="hook-list">
          {project.hookSuggestions.map((s) => (
            <li key={s.id}>{s.text}</li>
          ))}
        </ul>
        <label className="field">
          <span>Full-video URL</span>
          <input
            type="url"
            value={hookUrl}
            onChange={(e) => setHookUrl(e.target.value)}
            placeholder="https://"
          />
        </label>
        <button
          type="button"
          className="btn primary"
          disabled
          title="Publishing is not implemented in the shell"
          onClick={() => hookPublishingStub.publish()}
        >
          Publish (disabled)
        </button>
      </aside>
    </div>
  );
}
