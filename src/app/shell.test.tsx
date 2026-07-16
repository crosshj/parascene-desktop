import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";

const store = new Map<string, string>();

let fixtureCreations: Array<Record<string, unknown>> = [];

let fixtureSyncStatus = {
  rootPath: "/tmp/Movies/Parascene",
  lastSyncAt: null as string | null,
  total: 0,
  local: 0,
  remote: 0,
  queued: 0,
  downloading: 0,
  failed: 0,
  withThumb: 0,
  withMedia: 0,
  missingThumbCacheable: 0,
  missingMediaCacheable: 0,
  mediaBytes: 0,
  thumbsBytes: 0,
  withoutCloudUrls: [] as { id: string; title: string; filename: string | null }[],
};

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
  if (cmd === "auth_ensure_access_token") return "at";
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
  if (
    cmd === "library_ensure_ready" ||
    cmd === "library_sync_status" ||
    cmd === "library_apply_manifest"
  ) {
    return fixtureSyncStatus;
  }
  if (
    cmd === "library_download_pending" ||
    cmd === "library_download_ids" ||
    cmd === "library_download_thumbs" ||
    cmd === "library_cache_missing_thumbs" ||
    cmd === "library_cache_missing_media"
  ) {
    return {
      downloaded: 0,
      failed: 0,
      skipped: 0,
      status: fixtureSyncStatus,
    };
  }
  if (cmd === "library_ensure_local") {
    return;
  }
  if (cmd === "library_list_creations") {
    return fixtureCreations;
  }
  if (cmd === "library_list_creations_page") {
    return {
      creations: fixtureCreations,
      total: fixtureCreations.length,
      offset: 0,
      limit: 80,
      hasMore: false,
    };
  }
  if (cmd === "library_filter_counts") {
    return {
      all: fixtureCreations.length,
      video: 0,
      image: 0,
      audio: 0,
      groups: 0,
      localOnly: 0,
      published: 0,
      unpublished: 0,
      aspect11: 0,
      aspect916: 0,
      aspect45: 0,
      aspect169: 0,
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

async function logIn(user: ReturnType<typeof userEvent.setup>) {
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

  await user.click(await screen.findByRole("button", { name: "Log in" }));
}

describe("auth shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    localStorage.clear();
    oauthHandler = null;
    fixtureCreations = [];
    fixtureSyncStatus = {
      rootPath: "/tmp/Movies/Parascene",
      lastSyncAt: null,
      total: 0,
      local: 0,
      remote: 0,
      queued: 0,
      downloading: 0,
      failed: 0,
      withThumb: 0,
      withMedia: 0,
      missingThumbCacheable: 0,
      missingMediaCacheable: 0,
      mediaBytes: 0,
      thumbsBytes: 0,
      withoutCloudUrls: [],
    };
  });

  it("shows login screen until authenticated (no mock login)", async () => {
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "Log in" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Video preview")).not.toBeInTheDocument();
    expect(screen.queryByText("Mock login")).not.toBeInTheDocument();
  });

  it("logs in through Parascene and lands on Library by default", async () => {
    const user = userEvent.setup();
    render(<App />);

    await logIn(user);

    await waitFor(() => {
      expect(screen.getByLabelText("Creations")).toBeInTheDocument();
    });
    expect(screen.getByText("@test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Library" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("navigation", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Creations" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Sync" })).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Sync from cloud" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No local creations yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Director" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Editor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publisher" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(
      await screen.findByRole("button", { name: "Log in" }),
    ).toBeInTheDocument();
  });

  it("hides mode tabs until a project is open on the Project tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await logIn(user);
    await screen.findByLabelText("Creations");

    await user.click(screen.getByRole("button", { name: "Project" }));
    expect(screen.getByLabelText("Project picker")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Director" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(screen.getByLabelText("Video preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Director" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publisher" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Editor" }));
    expect(screen.getByLabelText("Assets")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Library" }));
    expect(screen.getByLabelText("Creations")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Director" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Project" }));
    expect(screen.getByLabelText("Assets")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editor" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Director" }));
    await user.click(screen.getByRole("button", { name: "Close project" }));
    expect(screen.getByLabelText("Project picker")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Director" })).not.toBeInTheDocument();
  });

  it("restores open project and tabs after remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);

    await logIn(user);
    await screen.findByLabelText("Creations");

    await user.click(screen.getByRole("button", { name: "Project" }));
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Editor" }));
    expect(screen.getByLabelText("Assets")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Library" }));
    expect(screen.getByLabelText("Creations")).toBeInTheDocument();

    unmount();
    render(<App />);

    // Auth + shell session restore — land on Library Creations with project still open.
    await waitFor(() => {
      expect(screen.getByLabelText("Creations")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Library" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Project" }));
    expect(screen.getByLabelText("Assets")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editor" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("switches Library Creations and Sync surfaces", async () => {
    const user = userEvent.setup();
    render(<App />);

    await logIn(user);
    await screen.findByLabelText("Creations");
    expect(
      await screen.findByRole("button", { name: "Sync from cloud" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sync" }));
    expect(screen.getByLabelText("Sync")).toBeInTheDocument();
    expect(await screen.findByText(/0 creations/)).toBeInTheDocument();
    expect(screen.getByText(/0 local · 0 remote/)).toBeInTheDocument();
    expect(screen.getByLabelText("Sync activity")).toBeInTheDocument();
    expect(
      screen.getByText(/Items appear as they queue/),
    ).toBeInTheDocument();
    expect(screen.getByText(/On disk:/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clear finished" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Sync from cloud" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Previews cached" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Media cached" }),
    ).toBeDisabled();
  });
});
