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

    await screen.findByRole("heading", { name: "First" });
    const previous = screen.getByRole("button", {
      name: "Previous grouped image",
    });
    const next = screen.getByRole("button", {
      name: "Next grouped image",
    });

    await user.click(next);
    expect(screen.getByRole("heading", { name: "Second" })).toBeInTheDocument();
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
});
