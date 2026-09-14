import { useEffect, useRef, useState } from "react";
import {
  assistantChatInvokePayload,
  replyFromAssistantResult,
  type AssistantChatTurn,
} from "../../project/assistantChat";
import { cancelAssistantChat } from "../../project/assistantLlm";
import { requestOpenSettings } from "../../settings/events";
import { serviceInvoke } from "../../services/serviceClient";
import { AssistantMarkdown } from "./assistantChatMd";

type AssistantPaneProps = {
  projectId: string;
  projectTitle: string;
  messages: AssistantChatTurn[];
  onPersist: (messages: AssistantChatTurn[]) => void;
  onCollapse: () => void;
  drawer?: boolean;
};

export function AssistantPane({
  projectId,
  projectTitle,
  messages,
  onPersist,
  onCollapse,
  drawer = false,
}: AssistantPaneProps) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const generationRef = useRef(0);
  const canSend = Boolean(prompt.trim()) && !busy;

  useEffect(() => {
    const node = historyRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, busy, error]);

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, 128)}px`;
  }, [prompt]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      void cancelAssistantChat();
    };
  }, []);

  const stop = () => {
    if (!busy) return;
    generationRef.current += 1;
    setBusy(false);
    setError(null);
    void cancelAssistantChat();
  };

  const submit = () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    const userTurn: AssistantChatTurn = {
      role: "user",
      content: trimmed,
      at: new Date().toISOString(),
    };
    const nextMessages = [...messages, userTurn];
    const generation = ++generationRef.current;
    onPersist(nextMessages);
    setPrompt("");
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        const handle = await serviceInvoke({
          service: "local",
          operation: "assistant_chat",
          projectId,
          payload: assistantChatInvokePayload({
            projectId,
            projectTitle,
            messages,
            userMessage: trimmed,
          }),
        });
        if (generation !== generationRef.current) return;
        if (handle.mode !== "result") {
          throw new Error("Assistant did not return a reply.");
        }
        const reply = replyFromAssistantResult(handle.data);
        if (!reply) throw new Error("Assistant returned an empty reply.");
        onPersist([
          ...nextMessages,
          {
            role: "assistant",
            content: reply,
            at: new Date().toISOString(),
          },
        ]);
      } catch (err) {
        if (generation !== generationRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        if (/cancelled/i.test(message)) return;
        setError(message);
      } finally {
        if (generation === generationRef.current) setBusy(false);
      }
    })();
  };

  return (
    <aside
      className={
        drawer ? "editor-assistant-pane is-drawer" : "editor-assistant-pane"
      }
      aria-label="Assistant"
      tabIndex={-1}
      onPointerDown={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.closest("button, input, textarea, a, select, label")) {
          return;
        }
        event.currentTarget.focus({ preventScroll: true });
      }}
    >
      <div className="editor-pane-head">
        <h2>Assistant</h2>
        <button
          type="button"
          className="editor-pane-collapse"
          onClick={onCollapse}
          title={drawer ? "Close assistant" : "Collapse assistant"}
          aria-label={drawer ? "Close assistant" : "Collapse assistant"}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path
              fill="currentColor"
              d="M5.5 12.75 10.25 8 5.5 3.25 6.55 2.2l5.8 5.8-5.8 5.8z"
            />
          </svg>
        </button>
      </div>

      <div className="editor-assistant-history" ref={historyRef}>
        {messages.length === 0 ? (
          <p className="editor-assistant-msg">
            Talk about this project. Rewrite a generate prompt. Assistant
            can look up Assets and the timeline. It cannot generate.
          </p>
        ) : null}
        {messages.map((turn, i) =>
          turn.role === "user" ? (
            <p key={`${turn.at}-${i}`} className="editor-assistant-msg is-user">
              {turn.content}
            </p>
          ) : (
            <div
              key={`${turn.at}-${i}`}
              className="editor-assistant-msg is-assistant"
            >
              <AssistantMarkdown text={turn.content} />
            </div>
          ),
        )}
        {busy ? (
          <p className="editor-assistant-msg is-pending">Thinking…</p>
        ) : null}
        {error ? (
          <p className="editor-assistant-msg is-error" role="alert">
            {error}{" "}
            {/API key|Settings/i.test(error) ? (
              <button
                type="button"
                className="btn ghost"
                onClick={() => requestOpenSettings()}
              >
                Settings
              </button>
            ) : null}
          </p>
        ) : null}
      </div>

      <div className="editor-assistant-composer">
        <div className="editor-assistant-composer-bar">
          <label className="editor-assistant-input-label">
            <span className="visually-hidden">Message</span>
            <textarea
              ref={inputRef}
              rows={1}
              placeholder="Ask about this project…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key !== "Enter" || e.shiftKey) return;
                e.preventDefault();
                submit();
              }}
            />
          </label>
          <button
            type="button"
            className={
              busy
                ? "editor-assistant-send is-stop"
                : "editor-assistant-send"
            }
            onClick={busy ? stop : submit}
            disabled={!busy && !canSend}
            aria-label={busy ? "Stop" : "Send"}
          >
            {busy ? (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
                <rect
                  x="4.35"
                  y="4.35"
                  width="7.3"
                  height="7.3"
                  rx="1.2"
                  fill="currentColor"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden>
                <path
                  d="M8 3.1v9.3M4.2 7 8 3.1 11.8 7"
                  stroke="currentColor"
                  strokeWidth="1.55"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}
