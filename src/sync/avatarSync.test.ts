import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
const convertFileSrcMock = vi.fn((path: string) => `asset://localhost/${path}`);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  convertFileSrc: (path: string) => convertFileSrcMock(path),
}));

vi.mock("../auth/session", () => ({
  getMemorySession: vi.fn(() => null),
}));

describe("avatarSync", () => {
  beforeEach(async () => {
    invokeMock.mockReset();
    convertFileSrcMock.mockClear();
    const { clearUserAvatarDisplay } = await import("./avatarSync");
    clearUserAvatarDisplay();
  });

  afterEach(async () => {
    const { clearUserAvatarDisplay } = await import("./avatarSync");
    clearUserAvatarDisplay();
  });

  it("uses letter placeholder when there is no picture URL", async () => {
    const { ensureUserAvatar, getUserAvatarDisplay } = await import(
      "./avatarSync"
    );
    const result = await ensureUserAvatar({
      sub: "user-1",
      picture: undefined,
    });
    expect(result.src).toBeNull();
    expect(result.ready).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(getUserAvatarDisplay().reason).toMatch(/no avatar/i);
  });

  it("stores convertFileSrc when Rust returns a verified local path", async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      localPath: "/Movies/Parascene/Cache/avatars/user-1_abcd.png",
      reason: null,
    });
    const { ensureUserAvatar } = await import("./avatarSync");
    const result = await ensureUserAvatar({
      sub: "user-1",
      picture: "https://www.parascene.com/avatars/a.png",
    });
    expect(invokeMock).toHaveBeenCalledWith("auth_ensure_user_avatar", {
      userId: "user-1",
      pictureUrl: "https://www.parascene.com/avatars/a.png",
    });
    expect(result.src).toBe(
      "asset://localhost//Movies/Parascene/Cache/avatars/user-1_abcd.png",
    );
    expect(result.ready).toBe(true);
  });

  it("clears src when Rust reports download/validation failure", async () => {
    invokeMock.mockResolvedValue({
      ok: false,
      localPath: null,
      reason: "Avatar body is not a recognized image",
    });
    const { ensureUserAvatar } = await import("./avatarSync");
    const result = await ensureUserAvatar({
      sub: "user-1",
      picture: "https://www.parascene.com/avatars/bad",
    });
    expect(result.src).toBeNull();
    expect(result.ready).toBe(true);
    expect(result.reason).toMatch(/not a recognized image/i);
  });

  it("rejectUserAvatarDisplay drops a broken img src", async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      localPath: "/tmp/a.png",
      reason: null,
    });
    const {
      ensureUserAvatar,
      rejectUserAvatarDisplay,
      getUserAvatarDisplay,
    } = await import("./avatarSync");
    await ensureUserAvatar({
      sub: "user-1",
      picture: "https://www.parascene.com/avatars/a.png",
    });
    expect(getUserAvatarDisplay().src).toBeTruthy();
    rejectUserAvatarDisplay("Image failed to load");
    expect(getUserAvatarDisplay().src).toBeNull();
    expect(getUserAvatarDisplay().ready).toBe(true);
  });
});
