import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { CreationLightbox } from "./CreationLightbox";
import type { Creation } from "./types";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => {}),
}));

function creation(
  id: string,
  title: string,
  overrides: Partial<Creation> = {},
): Creation {
  return {
    id,
    title,
    mediaType: "image",
    remoteUrl: `https://example.test/${id}.png`,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: `/tmp/${id}.png`,
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "2026-07-18T00:00:00Z",
    downloadState: "local",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-07-18T00:00:00Z",
    filename: `${id}.png`,
    description: null,
    color: null,
    status: "completed",
    width: 1024,
    height: 1024,
    aspectRatio: "1:1",
    nsfw: false,
    isModeratedError: false,
    remoteJson: null,
    ...overrides,
  };
}

describe("CreationLightbox group carousel", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("loops with overlay buttons and arrow keys", async () => {
    const members = [creation("1", "First"), creation("2", "Second")];
    const group = creation("group", "Group", {
      filename: "group/cover.png",
      remoteJson: JSON.stringify({
        meta: {
          group: {
            kind: "group_creations",
            source_creation_ids: [1, 2],
            source_creations: [{ id: 1 }, { id: 2 }],
          },
        },
      }),
    });
    invoke.mockImplementation(async (command: string) => {
      if (command === "library_get_creations") return members;
      if (command === "library_ensure_local") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });

    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <CreationLightbox creation={group} onClose={vi.fn()} />
      </ConfirmProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Group" }),
    ).toBeInTheDocument();
    await screen.findByRole("heading", { name: "First" });
    const previous = screen.getByRole("button", {
      name: "Previous in group",
    });
    const next = screen.getByRole("button", {
      name: "Next in group",
    });

    await user.click(next);
    expect(screen.getByRole("heading", { name: "Second" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Group" })).toBeInTheDocument();
    await user.click(next);
    expect(screen.getByRole("heading", { name: "First" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Second" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "First" })).toBeInTheDocument();

    await user.click(previous);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Second" }),
      ).toBeInTheDocument();
    });
  });

  it("carousels video group members with looping playback", async () => {
    const members = [
      creation("10", "Clip A", {
        mediaType: "video",
        localPath: "/tmp/10.mp4",
        filename: "10.mp4",
      }),
      creation("11", "Clip B", {
        mediaType: "video",
        localPath: "/tmp/11.mp4",
        filename: "11.mp4",
      }),
    ];
    const group = creation("vg", "Videos", {
      mediaType: "video",
      filename: "group/cover.mp4",
      localPath: "/tmp/cover.mp4",
      remoteJson: JSON.stringify({
        meta: {
          group: {
            kind: "group_creations",
            source_creation_ids: [10, 11],
          },
          desktop: {
            role: "project_videos",
            client: "parascene-desktop",
            projectId: "p1",
          },
        },
      }),
    });
    invoke.mockImplementation(async (command: string) => {
      if (command === "library_get_creations") return members;
      if (command === "library_ensure_local") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });

    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <CreationLightbox creation={group} onClose={vi.fn()} />
      </ConfirmProvider>,
    );

    await screen.findByRole("heading", { name: "Videos" });
    await screen.findByRole("heading", { name: "Clip A" });
    const video = document.querySelector("video");
    expect(video).toBeTruthy();
    expect(video?.hasAttribute("loop")).toBe(true);
    expect(video?.hasAttribute("autoplay")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Next in group" }));
    expect(screen.getByRole("heading", { name: "Clip B" })).toBeInTheDocument();
    const nextVideo = document.querySelector("video");
    expect(nextVideo?.getAttribute("src") ?? "").toContain("11.mp4");
    expect(nextVideo?.hasAttribute("loop")).toBe(true);
  });
});

describe("CreationLightbox cloud A/V", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) => {
      if (command === "library_ensure_local") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it("shows Suno cloud audio instead of Saving locally", async () => {
    const suno = creation("20794", "Beat the Meat", {
      mediaType: "audio",
      localPath: null,
      localThumbPath: "/tmp/20794.png",
      downloadState: "remote",
      remoteUrl:
        "https://www.parascene.com/api/images/created/26_x.png?creation_id=20794",
      remoteJson: JSON.stringify({
        meta: {
          import: {
            provider: "suno",
            url: "https://suno.com/song/abc",
          },
        },
      }),
    });
    render(
      <ConfirmProvider>
        <CreationLightbox creation={suno} onClose={vi.fn()} />
      </ConfirmProvider>,
    );

    expect(screen.getAllByRole("button", { name: "Play on Suno" }).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/cloud · Suno/i)).toBeInTheDocument();
    expect(screen.getByText("Cloud audio · Suno")).toBeInTheDocument();
    expect(screen.queryByText("Saving locally…")).not.toBeInTheDocument();
  });
});
