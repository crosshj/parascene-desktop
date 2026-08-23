import { describe, expect, it } from "vitest";
import type { Creation } from "../../library/types";
import type { ProjectAsset } from "../../project/types";
import { projectImagePickerAssets } from "./projectImagePickerAssets";

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
              source_creation_ids: [201, 202],
            },
          },
        }),
      } as Creation,
      "201": { id: "201", mediaType: "image" } as Creation,
      "202": { id: "202", mediaType: "video" } as Creation,
      "200": { id: "200", mediaType: "image" } as Creation,
    };

    const rows = projectImagePickerAssets(assets, creationsById, {
      imagesGroupId: "100",
      videosGroupId: null,
    });

    expect(rows.map((row) => row.id)).toEqual(["201", "200"]);
  });
});
