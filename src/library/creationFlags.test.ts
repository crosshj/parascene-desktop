import { describe, expect, it } from "vitest";
import {
  creationCardTitle,
  isGroupCreation,
  isPublishedCreation,
} from "./creationFlags";

describe("creationFlags", () => {
  it("detects group_creations from remoteJson meta", () => {
    expect(
      isGroupCreation({
        remoteJson: JSON.stringify({
          meta: { group: { kind: "group_creations" } },
        }),
      }),
    ).toBe(true);
  });

  it("detects groups from group/ filename", () => {
    expect(
      isGroupCreation({ filename: "group/26_x.png", remoteJson: null }),
    ).toBe(true);
  });

  it("rejects non-groups", () => {
    expect(
      isGroupCreation({
        filename: "26_x.png",
        remoteJson: JSON.stringify({ meta: {} }),
      }),
    ).toBe(false);
  });

  it("reads published flag", () => {
    expect(isPublishedCreation({ published: true })).toBe(true);
    expect(isPublishedCreation({ published: false })).toBe(false);
  });

  it("uses real titles and falls back to Untitled", () => {
    expect(
      creationCardTitle({
        id: "1",
        title: "Sunset",
        filename: "a.png",
        remoteJson: JSON.stringify({ title: "Sunset" }),
      }),
    ).toEqual({ text: "Sunset", untitled: false });

    expect(
      creationCardTitle({
        id: "1",
        title: "a.png",
        filename: "a.png",
        remoteJson: JSON.stringify({ title: null }),
      }),
    ).toEqual({ text: "Untitled", untitled: true });

    expect(
      creationCardTitle({
        id: "42",
        title: "Creation 42",
        filename: null,
        remoteJson: null,
      }),
    ).toEqual({ text: "Untitled", untitled: true });
  });
});
