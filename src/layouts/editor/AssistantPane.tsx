import { useState } from "react";
import { llmAssistantStub } from "../../capabilities";

type AssistantPaneProps = {
  onCollapse: () => void;
  drawer?: boolean;
};

type ProposalStub = {
  id: string;
  title: string;
  summary: string;
};

const STUB_PROPOSALS: ProposalStub[] = [
  {
    id: "p1",
    title: "Tighten the opening",
    summary: "Trim silence before the first line and land on the vocal earlier.",
  },
  {
    id: "p2",
    title: "Cut on musical phrases",
    summary: "Align edit points with phrase boundaries in the bed track.",
  },
];

export function AssistantPane({
  onCollapse,
  drawer = false,
}: AssistantPaneProps) {
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<string[]>([
    "Ask for an edit or shot idea — proposals appear below.",
  ]);
  const [proposals] = useState(STUB_PROPOSALS);

  const submit = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setHistory((prev) => [...prev, trimmed]);
    setPrompt("");
    void llmAssistantStub.ask(trimmed);
  };

  return (
    <aside
      className={
        drawer ? "editor-assistant-pane is-drawer" : "editor-assistant-pane"
      }
      aria-label="Assistant"
    >
      <div className="editor-pane-head">
        <h2>Assistant</h2>
        <button type="button" className="btn ghost" onClick={onCollapse}>
          Collapse
        </button>
      </div>

      <div className="editor-assistant-history">
        {history.map((line, i) => (
          <p key={`${i}-${line.slice(0, 12)}`} className="editor-assistant-msg">
            {line}
          </p>
        ))}

        <div className="editor-proposal-list" aria-label="Edit proposals">
          {proposals.map((p) => (
            <article key={p.id} className="editor-proposal-card">
              <h3>{p.title}</h3>
              <p className="muted">{p.summary}</p>
              <div className="editor-proposal-actions">
                <button type="button" className="btn ghost" disabled>
                  Preview
                </button>
                <button type="button" className="btn primary" disabled>
                  Apply
                </button>
                <button type="button" className="btn ghost" disabled>
                  Choose
                </button>
                <button type="button" className="btn ghost" disabled>
                  Discard
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="editor-assistant-composer">
        <label className="editor-assistant-input-label">
          <span className="visually-hidden">Instruction</span>
          <textarea
            rows={3}
            placeholder="Describe an edit…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <button
          type="button"
          className="btn primary editor-assistant-ask"
          onClick={submit}
          disabled={!prompt.trim()}
        >
          Ask / Propose
        </button>
      </div>
    </aside>
  );
}
