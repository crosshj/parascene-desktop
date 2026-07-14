import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";

const store = new Map<string, string>();

const invoke = vi.fn(async (cmd: string, args?: { key?: string; value?: string }) => {
  if (cmd === "keychain_get") return store.get(args?.key ?? "") ?? null;
  if (cmd === "keychain_set") {
    store.set(args?.key ?? "", args?.value ?? "");
    return null;
  }
  if (cmd === "keychain_delete") {
    store.delete(args?.key ?? "");
    return null;
  }
  if (cmd === "cancel_oauth_listener") return null;
  if (cmd === "start_oauth_listener") return 17423;
  if (cmd === "http_post_json") {
    return {
      status: 200,
      body: JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 900,
      }),
    };
  }
  if (cmd === "http_get_bearer") {
    return {
      status: 200,
      body: JSON.stringify({
        sub: "u1",
        name: "Test User",
        preferred_username: "test",
      }),
    };
  }
  throw new Error(`unexpected invoke: ${cmd}`);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) =>
    invoke(...(args as [string, { key?: string; value?: string }?])),
}));

let oauthHandler: ((event: { payload: unknown }) => void) | null = null;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: (e: { payload: unknown }) => void) => {
    oauthHandler = handler;
    return () => {
      oauthHandler = null;
    };
  }),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

describe("auth shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    oauthHandler = null;
  });

  it("shows login screen until authenticated (no mock login)", async () => {
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "Log in" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Video preview")).not.toBeInTheDocument();
    expect(screen.queryByText("Mock login")).not.toBeInTheDocument();
  });

  it("logs in through Parascene and shows the app shell", async () => {
    const user = userEvent.setup();
    render(<App />);

    const { openUrl } = await import("@tauri-apps/plugin-opener");
    vi.mocked(openUrl).mockImplementationOnce(async (url: string | URL) => {
      const u = typeof url === "string" ? new URL(url) : url;
      const state = u.searchParams.get("state");
      queueMicrotask(() => {
        oauthHandler?.({
          payload: { code: "test-code", state },
        });
      });
    });

    await user.click(
      await screen.findByRole("button", { name: "Log in" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Video preview")).toBeInTheDocument();
    });
    expect(screen.getByText("@test")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Editor" }));
    expect(screen.getByLabelText("Assets")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(
      await screen.findByRole("button", { name: "Log in" }),
    ).toBeInTheDocument();
  });
});
