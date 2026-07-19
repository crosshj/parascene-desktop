import { describe, expect, it } from "vitest";
import {
  collectGroupMemberIds,
  creationCardTitle,
  groupEmbeddedSourceCreations,
  groupSourceCreationIds,
  isGroupCreation,
  isPublishedCreation,
  omitGroupMemberCreations,
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

  it("reads ordered source creation ids from groups", () => {
    expect(
      groupSourceCreationIds({
        remoteJson: JSON.stringify({
          meta: {
            group: {
              source_creations: [
                { id: "12" },
                { id: 7 },
                { id: "12" },
              ],
            },
          },
        }),
      }),
    ).toEqual(["12", "7"]);
  });

  it("prefers source_creation_ids order when present", () => {
    expect(
      groupSourceCreationIds({
        remoteJson: JSON.stringify({
          meta: {
            group: {
              source_creation_ids: [3, 1, 2],
              source_creations: [{ id: 1 }, { id: 2 }, { id: 3 }],
            },
          },
        }),
      }),
    ).toEqual(["3", "1", "2"]);
  });

  it("extracts embedded source creation rows", () => {
    expect(
      groupEmbeddedSourceCreations({
        remoteJson: JSON.stringify({
          meta: {
            group: {
              source_creations: [
                { id: 9, file_path: "/api/images/created/a.png", width: 10 },
                { id: "9" },
                "skip",
              ],
            },
          },
        }),
      }),
    ).toEqual([
      { id: "9", file_path: "/api/images/created/a.png", width: 10 },
    ]);
  });

  it("collects and omits group member ids from board lists", () => {
    const cover = {
      id: "g1",
      filename: "group/cover.png",
      remoteJson: JSON.stringify({
        meta: {
          group: {
            kind: "group_creations",
            source_creation_ids: [10, 11],
          },
        },
      }),
    };
    const members = collectGroupMemberIds([
      cover,
      { id: "10", remoteJson: null },
      { id: "12", remoteJson: null },
    ]);
    expect([...members].sort()).toEqual(["10", "11"]);
    expect(
      omitGroupMemberCreations(
        [{ id: "g1" }, { id: "10" }, { id: "12" }],
        members,
      ).map((r) => r.id),
    ).toEqual(["g1", "12"]);
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
