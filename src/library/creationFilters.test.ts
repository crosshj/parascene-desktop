import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER_TOGGLES,
  countFilterMatches,
  creationMatchesFilters,
  filterCreations,
  filterCreationsVisible,
  isLocalOnlyCreation,
  mergeFilterCounts,
  selectFilter,
  type CreationFilterToggles,
} from "./creationFilters";
import type { Creation } from "./types";

function makeCreation(
  overrides: Partial<Creation> & Pick<Creation, "id">,
): Creation {
  return {
    id: overrides.id,
    title: overrides.title ?? `Creation ${overrides.id}`,
    mediaType: overrides.mediaType ?? "image",
    remoteUrl:
      overrides.remoteUrl !== undefined
        ? overrides.remoteUrl
        : "https://cdn.example/x",
    thumbnailUrl: overrides.thumbnailUrl ?? null,
    fitThumbnailUrl: overrides.fitThumbnailUrl ?? null,
    videoUrl: overrides.videoUrl ?? null,
    filename: overrides.filename ?? null,
    width: overrides.width ?? null,
    height: overrides.height ?? null,
    aspectRatio: overrides.aspectRatio ?? null,
    localPath: overrides.localPath ?? null,
    localThumbPath: overrides.localThumbPath ?? null,
    published: overrides.published ?? false,
    publishedAt: overrides.publishedAt ?? null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
    prompt: overrides.prompt ?? null,
    description: overrides.description ?? null,
    color: overrides.color ?? null,
    status: overrides.status ?? "completed",
    downloadState: overrides.downloadState ?? "remote",
    checksum: overrides.checksum ?? null,
    expiresAt: overrides.expiresAt ?? null,
    nsfw: overrides.nsfw ?? false,
    isModeratedError: overrides.isModeratedError ?? false,
    remoteJson:
      overrides.remoteJson !== undefined
        ? overrides.remoteJson
        : JSON.stringify({ id: overrides.id }),
  };
}

describe("creationFilters", () => {
  const items = [
    makeCreation({
      id: "v1",
      mediaType: "video",
      published: true,
      aspectRatio: "16:9",
      width: 1920,
      height: 1080,
    }),
    makeCreation({
      id: "i1",
      mediaType: "image",
      published: false,
      downloadState: "local",
      localPath: "/tmp/a.png",
      aspectRatio: "1:1",
      width: 1024,
      height: 1024,
    }),
    makeCreation({
      id: "g1",
      mediaType: "image",
      filename: "group/cover.png",
      published: true,
      aspectRatio: "9:16",
      width: 9,
      height: 16,
    }),
    makeCreation({
      id: "a1",
      mediaType: "audio",
      published: false,
      aspectRatio: "4:5",
      width: 4,
      height: 5,
    }),
    makeCreation({
      id: "local1",
      mediaType: "image",
      remoteUrl: null,
      remoteJson: null,
      aspectRatio: "1:1",
      width: 512,
      height: 512,
    }),
  ];

  it("OR media types when any media toggle is on", () => {
    const toggles: CreationFilterToggles = {
      ...EMPTY_FILTER_TOGGLES,
      video: true,
    };
    const ids = filterCreations(items, toggles, new Set()).map((c) => c.id);
    expect(ids).toEqual(["v1"]);
  });

  it("ANDs attribute toggles with media", () => {
    const toggles: CreationFilterToggles = {
      ...EMPTY_FILTER_TOGGLES,
      published: true,
    };
    const ids = filterCreations(items, toggles, new Set()).map((c) => c.id);
    expect(ids).toEqual(["v1", "g1"]);
  });

  it("filters groups", () => {
    expect(
      creationMatchesFilters(
        items[2],
        { ...EMPTY_FILTER_TOGGLES, groups: true },
        new Set(),
      ),
    ).toBe(true);
  });

  it("local-only means not in the cloud, not downloaded on disk", () => {
    expect(isLocalOnlyCreation(items[1])).toBe(false); // cached cloud asset
    expect(isLocalOnlyCreation(items[0])).toBe(false);
    expect(isLocalOnlyCreation(items[4])).toBe(true);
    expect(
      creationMatchesFilters(
        items[4],
        { ...EMPTY_FILTER_TOGGLES, localOnly: true },
        new Set(),
      ),
    ).toBe(true);
    expect(
      creationMatchesFilters(
        items[1],
        { ...EMPTY_FILTER_TOGGLES, localOnly: true },
        new Set(),
      ),
    ).toBe(false);
  });

  it("filters by aspect presets", () => {
    expect(
      filterCreations(
        items,
        { ...EMPTY_FILTER_TOGGLES, aspect169: true },
        new Set(),
      ).map((c) => c.id),
    ).toEqual(["v1"]);
    expect(
      filterCreations(
        items,
        { ...EMPTY_FILTER_TOGGLES, aspect11: true },
        new Set(),
      ).map((c) => c.id),
    ).toEqual(["i1", "local1"]);
    expect(
      filterCreations(
        items,
        { ...EMPTY_FILTER_TOGGLES, aspect916: true },
        new Set(),
      ).map((c) => c.id),
    ).toEqual(["g1"]);
    expect(
      filterCreations(
        items,
        { ...EMPTY_FILTER_TOGGLES, aspect45: true },
        new Set(),
      ).map((c) => c.id),
    ).toEqual(["a1"]);
  });

  it("selected / not-selected against the selection set", () => {
    const selected = new Set(["i1", "g1"]);
    expect(
      filterCreations(
        items,
        { ...EMPTY_FILTER_TOGGLES, selected: true },
        selected,
      ).map((c) => c.id),
    ).toEqual(["i1", "g1"]);
    expect(
      filterCreations(
        items,
        { ...EMPTY_FILTER_TOGGLES, notSelected: true },
        selected,
      ).map((c) => c.id),
    ).toEqual(["v1", "a1", "local1"]);
  });

  it("filters creations in the open project", () => {
    const inProject = new Set(["i1", "a1"]);
    expect(
      filterCreations(
        items,
        { ...EMPTY_FILTER_TOGGLES, inProject: true },
        new Set(),
        inProject,
      ).map((c) => c.id),
    ).toEqual(["i1", "a1"]);
  });

  it("published + unpublished cannot both apply under exclusive select", () => {
    const published = selectFilter(EMPTY_FILTER_TOGGLES, "published");
    const bothAttempt = selectFilter(published, "unpublished");
    expect(bothAttempt.published).toBe(false);
    expect(bothAttempt.unpublished).toBe(true);
    expect(
      filterCreations(items, bothAttempt, new Set()).map((c) => c.id),
    ).toEqual(["i1", "a1", "local1"]);
  });

  it("selectFilter is exclusive; re-click clears to all", () => {
    const on = selectFilter(EMPTY_FILTER_TOGGLES, "video");
    expect(on.video).toBe(true);
    expect(selectFilter(on, "all")).toEqual(EMPTY_FILTER_TOGGLES);
    expect(selectFilter(on, "video")).toEqual(EMPTY_FILTER_TOGGLES);
    const switched = selectFilter(on, "image");
    expect(switched.video).toBe(false);
    expect(switched.image).toBe(true);
  });

  it("countFilterMatches tallies the loaded catalogue", () => {
    const counts = countFilterMatches(items, new Set(["v1"]));
    expect(counts.all).toBe(5);
    expect(counts.video).toBe(1);
    expect(counts.image).toBe(3);
    expect(counts.audio).toBe(1);
    expect(counts.groups).toBe(1);
    expect(counts.localOnly).toBe(1);
    expect(counts.published).toBe(2);
    expect(counts.unpublished).toBe(3);
    expect(counts.selected).toBe(1);
    expect(counts.notSelected).toBe(4);
    expect(counts.inProject).toBe(0);
    expect(counts.aspect11).toBe(2);
    expect(counts.aspect916).toBe(1);
    expect(counts.aspect45).toBe(1);
    expect(counts.aspect169).toBe(1);
  });

  it("not-selected deferred keep leaves newly selected items visible", () => {
    const toggles = selectFilter(EMPTY_FILTER_TOGGLES, "notSelected");
    const selected = new Set(["i1"]);
    const deferred = new Set(["i1"]);
    const ids = filterCreationsVisible(
      items,
      toggles,
      selected,
      deferred,
    ).map((c) => c.id);
    expect(ids).toEqual(["v1", "i1", "g1", "a1", "local1"]);
    expect(
      filterCreations(items, toggles, selected).map((c) => c.id),
    ).toEqual(["v1", "g1", "a1", "local1"]);
  });

  it("selected deferred keep leaves newly deselected items visible", () => {
    const toggles = selectFilter(EMPTY_FILTER_TOGGLES, "selected");
    const selected = new Set(["v1"]);
    const deferred = new Set(["i1"]);
    const ids = filterCreationsVisible(
      items,
      toggles,
      selected,
      deferred,
    ).map((c) => c.id);
    expect(ids).toEqual(["v1", "i1"]);
    expect(filterCreations(items, toggles, selected).map((c) => c.id)).toEqual([
      "v1",
    ]);
  });

  it("mergeFilterCounts uses catalog totals and selection size", () => {
    const merged = mergeFilterCounts(
      {
        all: 2842,
        video: 400,
        image: 2400,
        audio: 42,
        groups: 50,
        localOnly: 0,
        published: 1000,
        unpublished: 1842,
        aspect11: 100,
        aspect916: 200,
        aspect45: 50,
        aspect169: 80,
      },
      new Set(["a", "b", "c"]),
      new Set(["x", "y"]),
    );
    expect(merged.all).toBe(2842);
    expect(merged.video).toBe(400);
    expect(merged.localOnly).toBe(0);
    expect(merged.aspect916).toBe(200);
    expect(merged.selected).toBe(3);
    expect(merged.notSelected).toBe(2839);
    expect(merged.inProject).toBe(2);
  });
});
