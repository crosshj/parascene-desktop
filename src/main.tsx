import React from "react";
import ReactDOM from "react-dom/client";

function renderBootstrapFailure(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const stack = error instanceof Error ? error.stack ?? "" : "";
  root.innerHTML = `
    <div style="padding:2rem;font-family:system-ui,sans-serif;background:#121214;color:#ececf0;min-height:100vh;box-sizing:border-box">
      <h1 style="margin:0 0 1rem;font-size:1.25rem">Parascene failed to start</h1>
      <p style="margin:0 0 1rem;color:#a0a0ab">${message.replace(/</g, "&lt;")}</p>
      ${
        stack
          ? `<pre style="white-space:pre-wrap;font-size:12px;color:#888;overflow:auto">${stack.replace(/</g, "&lt;")}</pre>`
          : ""
      }
      <button type="button" onclick="location.reload()" style="margin-top:1rem;padding:0.5rem 1rem;border-radius:8px;border:1px solid #444;background:#1c1c20;color:inherit;cursor:pointer">
        Reload app
      </button>
    </div>
  `;
}

window.addEventListener("error", (event) => {
  console.error("[bootstrap]", event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[bootstrap]", event.reason);
});

async function boot(): Promise<void> {
  try {
    const { default: App } = await import("./App");
    const root = document.getElementById("root");
    if (!root) throw new Error("Missing #root element");
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } catch (error) {
    console.error("[bootstrap]", error);
    renderBootstrapFailure(error);
  }
}

void boot();
