import { describe, expect, it } from "vitest";
import {
  aspectRatioFromCreation,
  aspectRatioFromMeta,
  creationPackHeight,
  parseAspectRatioString,
} from "./aspectRatio";
import { packByAspect, packByAspectStable } from "./CreationsMasonry";

describe("aspectRatio", () => {
  it("parses presets and freeform ratios", () => {
    expect(parseAspectRatioString("16:9")).toEqual({ w: 16, h: 9 });
    expect(parseAspectRatioString("4:5")).toEqual({ w: 4, h: 5 });
    expect(parseAspectRatioString("bad")).toBeNull();
  });

  it("prefers creative aspect_ratio string over pixels", () => {
    expect(
      aspectRatioFromCreation({
        width: 1024,
        height: 1024,
        aspectRatio: "16:9",
      }),
    ).toEqual({ w: 16, h: 9 });
    expect(
      aspectRatioFromCreation({
        width: 576,
        height: 1024,
        aspectRatio: "9:16",
      }),
    ).toEqual({ w: 9, h: 16 });
  });

  it("reads creative ratio from remote_json when denormalized field is a pixel dump", () => {
    expect(
      aspectRatioFromCreation({
        width: 1024,
        height: 1024,
        aspectRatio: "1024:1024",
        remoteJson: JSON.stringify({
          meta: { args: { aspect_ratio: "9:16" } },
        }),
      }),
    ).toEqual({ w: 9, h: 16 });
  });

  it("prefers real width/height over a square pixel-dump aspect_ratio string", () => {
    expect(
      aspectRatioFromCreation({
        width: 576,
        height: 1024,
        aspectRatio: "1024:1024",
      }),
    ).toEqual({ w: 9, h: 16 });
  });

  it("for groups, prefers cover pixels over pack-level creative aspect_ratio", () => {
    expect(
      aspectRatioFromCreation({
        width: 1008,
        height: 1008,
        aspectRatio: "9:16",
        filename: "group/17810_x.png",
        remoteJson: JSON.stringify({
          meta: {
            args: { aspect_ratio: "9:16" },
            group: {
              kind: "group_creations",
              cover_source_id: "17804",
              source_creations: [
                {
                  id: "17804",
                  width: 1008,
                  height: 1008,
                  meta: { args: { aspect_ratio: "1:1" } },
                },
              ],
            },
          },
        }),
      }),
    ).toEqual({ w: 1, h: 1 });
  });

  it("for groups without row pixels, uses cover source dimensions", () => {
    expect(
      aspectRatioFromCreation({
        width: null,
        height: null,
        aspectRatio: "9:16",
        remoteJson: JSON.stringify({
          meta: {
            args: { aspect_ratio: "9:16" },
            group: {
              kind: "group_creations",
              cover_source_id: 42,
              source_creations: [
                { id: 99, width: 16, height: 9 },
                { id: 42, width: 4, height: 5 },
              ],
            },
          },
        }),
      }),
    ).toEqual({ w: 4, h: 5 });
  });

  it("falls back to reduced pixel dimensions", () => {
    expect(
      aspectRatioFromCreation({ width: 768, height: 1376, aspectRatio: null }),
    ).toEqual({ w: 24, h: 43 });
  });

  it("reads aspect_ratio from meta.args", () => {
    expect(aspectRatioFromMeta({ args: { aspect_ratio: "9:16" } })).toBe(
      "9:16",
    );
    expect(aspectRatioFromMeta({ args: { prompt: "x" } })).toBeNull();
  });

  it("uses taller pack height for portrait", () => {
    expect(
      creationPackHeight({
        id: "1",
        title: "p",
        mediaType: "image",
        remoteUrl: null,
        thumbnailUrl: null,
        fitThumbnailUrl: null,
        videoUrl: null,
        localPath: null,
        localThumbPath: null,
        published: false,
        publishedAt: null,
        createdAt: "",
        downloadState: "remote",
        checksum: null,
        prompt: null,
        expiresAt: null,
        updatedAt: "",
        filename: null,
        description: null,
        color: null,
        status: null,
        width: 9,
        height: 16,
        aspectRatio: "9:16",
        nsfw: false,
        isModeratedError: false,
        remoteJson: null,
      }),
    ).toBeCloseTo(16 / 9);
  });
});

describe("packByAspect", () => {
  const base = {
    title: "t",
    mediaType: "image",
    remoteUrl: "https://x",
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: null,
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "",
    downloadState: "remote" as const,
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "",
    filename: null,
    description: null,
    color: null,
    status: "completed",
    nsfw: false,
    isModeratedError: false,
    remoteJson: null,
  };

  it("puts the next item into the currently shortest column", () => {
    const items = [
      { ...base, id: "a", width: 16, height: 9, aspectRatio: "16:9" },
      { ...base, id: "b", width: 16, height: 9, aspectRatio: "16:9" },
      { ...base, id: "c", width: 9, height: 16, aspectRatio: "9:16" },
    ];
    const cols = packByAspect(items, {
      columnCount: 2,
      columnWidth: 200,
      ready: true,
    });
    expect(cols[0].map((c) => c.id)).toEqual(["a", "c"]);
    expect(cols[1].map((c) => c.id)).toEqual(["b"]);
  });

  it("keeps sticky column assignments when packing again", () => {
    const assignment = new Map<string, number>();
    const layout = { columnCount: 2, columnWidth: 200, ready: true };
    const first = [
      { ...base, id: "a", width: 16, height: 9, aspectRatio: "16:9" },
      { ...base, id: "b", width: 16, height: 9, aspectRatio: "16:9" },
    ];
    packByAspectStable(first, layout, assignment);
    expect(assignment.get("a")).toBe(0);
    expect(assignment.get("b")).toBe(1);

    const tallerA = [
      { ...base, id: "a", width: 9, height: 16, aspectRatio: "9:16" },
      { ...base, id: "b", width: 16, height: 9, aspectRatio: "16:9" },
      { ...base, id: "c", width: 1, height: 1, aspectRatio: "1:1" },
    ];
    const cols = packByAspectStable(tallerA, layout, assignment);
    // a/b stay put; c joins the shorter column (b), even though a grew taller.
    expect(cols[0].map((c) => c.id)).toEqual(["a"]);
    expect(cols[1].map((c) => c.id)).toEqual(["b", "c"]);
  });
});
