import { describe, expect, it, vi } from "vitest";
import type { Creation } from "../../library/types";
import type { ProjectAsset } from "../../project/types";
import {
  bindAsyncUnlisten,
  creationsByIdUnchanged,
  pickerAssetsFingerprint,
  projectImagePickerAssets,
} from "./projectImagePickerAssets";

describe("projectImagePickerAssets", () => {
  it("expands Images cabinet members and filters to image media types", () => {
    const assets: ProjectAsset[] = [
      { id: "100", name: "Images", kind: "image" },
      { id: "200", name: "Loose still", kind: "image" },
    ];
    const creationsById: Record<string, Creation> = {
      "100": {
        id: "100",
        mediaType: "image",
        remoteJson: JSON.stringify({
          meta: {
            group: {
              kind: "group_creations",
              source_creation_ids: [201, 202],
            },
            desktop: {
              role: "project_images",
              client: "parascene-desktop",
              projectId: "p1",
            },
          },
        }),
      } as Creation,
      "201": { id: "201", mediaType: "image" } as Creation,
      "202": { id: "202", mediaType: "video" } as Creation,
      "200": { id: "200", mediaType: "image" } as Creation,
    };

    const rows = projectImagePickerAssets(assets, creationsById, {
      projectId: "p1",
      projectTitle: "Demo",
      projectCabinets: {
        imagesGroupId: "100",
        videosGroupId: null,
      },
    });

    expect(rows.map((row) => row.id)).toEqual(["201", "200"]);
  });

  it("treats unchanged creation maps as equal", () => {
    const row = {
      id: "201",
      mediaType: "image",
      updatedAt: "t1",
    } as Creation;
    expect(creationsByIdUnchanged({ "201": row }, { "201": { ...row } })).toBe(
      true,
    );
    expect(
      creationsByIdUnchanged(
        { "201": row },
        { "201": { ...row, updatedAt: "t2" } },
      ),
    ).toBe(false);
  });

  it("fingerprints picker assets by id/kind/name", () => {
    const a: ProjectAsset[] = [{ id: "1", name: "A", kind: "image" }];
    const b: ProjectAsset[] = [{ id: "1", name: "A", kind: "image" }];
    expect(pickerAssetsFingerprint(a)).toBe(pickerAssetsFingerprint(b));
  });

  it("unbinds a listener that resolves after cleanup", async () => {
    let resolvePending!: (off: () => void) => void;
    const pending = new Promise<() => void>((resolve) => {
      resolvePending = resolve;
    });
    const stop = bindAsyncUnlisten(pending);
    const off = vi.fn();
    stop();
    resolvePending(off);
    await Promise.resolve();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
