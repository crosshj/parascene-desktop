import { describe, expect, it, vi } from "vitest";
import { wipeProjectConfirmOptions } from "./confirmWipeProject";

describe("wipeProjectConfirmOptions", () => {
  it("uses the wipe confirm copy and calls deleteProject with progress", async () => {
    const deleteProject = vi.fn().mockResolvedValue(true);
    const options = wipeProjectConfirmOptions({
      id: "proj-1",
      title: "MyTestProject",
      deleteProject,
    });
    expect(options.title).toBe("Delete “MyTestProject”?");
    expect(options.confirmLabel).toBe("Delete project");
    expect(options.danger).toBe(true);
    expect(options.message).toContain("this computer and on Parascene");

    const setMessage = vi.fn();
    await options.onConfirm?.({ setMessage });
    expect(setMessage).toHaveBeenCalledWith("Looking up files on Parascene…");
    expect(deleteProject).toHaveBeenCalledWith("proj-1", {
      onProgress: setMessage,
    });
  });
});
