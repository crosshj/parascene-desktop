import { describe, expect, it } from "vitest";
import { cabinetPersistPatch } from "./cabinetPersist";

describe("cabinetPersistPatch", () => {
  it("clears a cabinet pointer that is also being hidden", () => {
    expect(
      cabinetPersistPatch({
        imagesGroupId: "28547",
        videosGroupId: null,
        hideIds: ["still-1", "28547"],
      }),
    ).toEqual({
      imagesGroupId: null,
      videosGroupId: null,
      hideIds: ["still-1", "28547"],
      addIds: [],
    });
  });

  it("keeps a new cover and hides the old one", () => {
    expect(
      cabinetPersistPatch({
        imagesGroupId: "new-cover",
        videosGroupId: null,
        hideIds: ["still-1", "28547"],
        addIds: ["new-cover"],
      }),
    ).toEqual({
      imagesGroupId: "new-cover",
      videosGroupId: null,
      hideIds: ["still-1", "28547"],
      addIds: ["new-cover"],
    });
  });

  it("keeps a cover that is being re-filed and clears one that is only hidden", () => {
    expect(
      cabinetPersistPatch({
        imagesGroupId: "28547",
        videosGroupId: "vid-cover",
        hideIds: ["28547", "vid-cover", "loose"],
        addIds: ["28547"],
      }),
    ).toEqual({
      imagesGroupId: "28547",
      videosGroupId: null,
      hideIds: ["vid-cover", "loose"],
      addIds: ["28547"],
    });
  });
});
