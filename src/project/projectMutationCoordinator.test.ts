import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  existingCreationIds: vi.fn<(ids: string[]) => Promise<string[]>>(),
  getCreations: vi.fn(),
  markProjectUsageStale: vi.fn<() => Promise<void>>(),
  repairProjectUsage: vi.fn<() => Promise<void>>(),
  replaceProjectUsage: vi.fn<() => Promise<void>>(),
}));

vi.mock("../library/catalogClient", () => ({
  existingCreationIds: native.existingCreationIds,
  getCreations: native.getCreations,
}));

vi.mock("./projectFolderClient", () => ({
  markProjectUsageStale: native.markProjectUsageStale,
  repairProjectUsage: native.repairProjectUsage,
  replaceProjectUsage: native.replaceProjectUsage,
}));

import {
  PROJECTS_STORAGE_KEY,
  createStoredProject,
  loadStoredProjectsStrict,
  partitionStoredProjects,
  saveStoredProjects,
} from "./projectStore";
import {
  mirrorStoredProjectsAfterNativeMembership,
  mutateStoredProjects,
  repairCorruptProjectTimeline,
} from "./projectMutationCoordinator";
import { collectProjectAssetUsage } from "./projectUsage";

describe("projectMutationCoordinator", () => {
  beforeEach(() => {
    localStorage.removeItem(PROJECTS_STORAGE_KEY);
    vi.clearAllMocks();
    native.existingCreationIds.mockImplementation(async (ids) => ids);
    native.getCreations.mockResolvedValue([]);
    native.markProjectUsageStale.mockResolvedValue();
    native.repairProjectUsage.mockResolvedValue();
    native.replaceProjectUsage.mockResolvedValue();
  });

  it("rejects a newly owned creation that disappeared before the document commit", async () => {
    const project = { ...createStoredProject("Race"), lifecycle: "ready" as const };
    saveStoredProjects([project]);
    native.existingCreationIds.mockResolvedValue([]);

    await expect(
      mutateStoredProjects((projects) =>
        projects.map((row) => ({ ...row, creationIds: ["deleted-result"] })),
      ),
    ).rejects.toThrow("deleted-result");

    expect(loadStoredProjectsStrict()[0].creationIds).toEqual([]);
    expect(native.markProjectUsageStale).not.toHaveBeenCalled();
  });

  it("persists a newly owned creation when the catalog still contains it", async () => {
    const project = { ...createStoredProject("Safe"), lifecycle: "ready" as const };
    saveStoredProjects([project]);

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({ ...row, creationIds: ["result-1"] })),
    );

    expect(next[0].creationIds).toEqual(["result-1"]);
    expect(native.existingCreationIds).toHaveBeenCalledWith(["result-1"]);
    expect(native.markProjectUsageStale).toHaveBeenCalledOnce();
    expect(native.replaceProjectUsage).toHaveBeenCalledOnce();
  });

  it("names the project when rejecting a new outside-folder reference", async () => {
    const project = {
      ...createStoredProject("Crossed Signals", ["owned"]),
      lifecycle: "ready" as const,
    };
    saveStoredProjects([project]);

    await expect(
      mutateStoredProjects((projects) =>
        projects.map((row) => ({
          ...row,
          timeline: [
            {
              id: "clip-1",
              label: "8.7s",
              startSec: 0,
              endSec: 8.7,
              assetId: "outside-1",
              kind: "video" as const,
            },
          ],
        })),
      ),
    ).rejects.toThrow(
      "Cannot save “Crossed Signals” clip “8.7s”: creation outside-1 is outside the project folder",
    );
  });

  it("allows a timeline ref to a cabinet member when the cover is in the folder", async () => {
    const project = {
      ...createStoredProject("Melting Trip", ["cover-videos"]),
      lifecycle: "ready" as const,
      videosGroupId: "cover-videos",
    };
    saveStoredProjects([project]);
    native.getCreations.mockResolvedValue([
      {
        id: "cover-videos",
        remoteJson: JSON.stringify({
          meta: {
            group: {
              kind: "group_creations",
              source_creation_ids: ["cabinet-vid"],
            },
          },
        }),
      },
    ]);

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({
        ...row,
        timeline: [
          {
            id: "clip-1",
            label: "4s",
            startSec: 0,
            endSec: 4,
            assetId: "cabinet-vid",
            kind: "video" as const,
          },
        ],
      })),
    );

    expect(next[0].creationIds).toEqual(["cover-videos"]);
    expect(next[0].timeline?.[0].assetId).toBe("cabinet-vid");
    expect(native.getCreations).toHaveBeenCalled();
  });

  it("rejects membership shrink that leaves a timeline reference outside without the legacy flag", async () => {
    const project = {
      ...createStoredProject("Crossed Signals", ["owned", "still-used"]),
      lifecycle: "ready" as const,
      timeline: [
        {
          id: "clip-1",
          label: "11.5s",
          startSec: 0,
          endSec: 11.5,
          assetId: "still-used",
          kind: "video" as const,
        },
      ],
    };
    saveStoredProjects([project]);

    await expect(
      mutateStoredProjects((projects) =>
        projects.map((row) => ({ ...row, creationIds: ["owned"] })),
      ),
    ).rejects.toThrow(
      "Cannot save “Crossed Signals” clip “11.5s”: creation still-used is outside the project folder",
    );
  });

  it("allows membership remirror to leave timeline refs outside after native commit", async () => {
    const project = {
      ...createStoredProject("Crossed Signals", ["owned", "still-used"]),
      lifecycle: "ready" as const,
      timeline: [
        {
          id: "clip-1",
          label: "11.5s",
          startSec: 0,
          endSec: 11.5,
          assetId: "still-used",
          kind: "video" as const,
        },
      ],
    };
    saveStoredProjects([project]);

    const next = await mirrorStoredProjectsAfterNativeMembership((projects) =>
      projects.map((row) => ({ ...row, creationIds: ["owned"] })),
    );

    expect(next[0].creationIds).toEqual(["owned"]);
    expect(
      collectProjectAssetUsage(next[0]).some(
        (row) => row.creationId === "still-used",
      ),
    ).toBe(true);
    expect(native.replaceProjectUsage).toHaveBeenCalled();
  });

  it("mutates a healthy project while leaving a corrupt sibling raw row intact", async () => {
    const healthy = {
      ...createStoredProject("Healthy", ["owned"]),
      lifecycle: "ready" as const,
    };
    const corruptRaw = {
      ...createStoredProject("Broken", ["asset-2"]),
      timeline: [
        {
          id: "broken-clip",
          label: "Broken",
          startSec: 5,
          endSec: 1,
          assetId: "asset-2",
        },
      ],
    };
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([healthy, corruptRaw]),
    );

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) =>
        row.id === healthy.id
          ? { ...row, title: "Healthy renamed" }
          : row,
      ),
    );

    expect(next).toHaveLength(1);
    expect(next[0].title).toBe("Healthy renamed");

    const stored = JSON.parse(
      localStorage.getItem(PROJECTS_STORAGE_KEY) ?? "[]",
    ) as unknown[];
    expect(stored).toHaveLength(2);
    const broken = stored.find(
      (row) =>
        row &&
        typeof row === "object" &&
        (row as { id?: string }).id === corruptRaw.id,
    ) as { timeline?: Array<{ id?: string }> };
    expect(broken.timeline?.[0]?.id).toBe("broken-clip");

    const partitioned = partitionStoredProjects();
    expect(partitioned.corrupt).toHaveLength(1);
    expect(partitioned.projects[0].title).toBe("Healthy renamed");
  });

  it("repairs a corrupt project timeline and then allows strict load", async () => {
    const corruptRaw = {
      ...createStoredProject("Broken", ["asset-1"]),
      timeline: [
        {
          id: "good-clip",
          label: "Good",
          startSec: 0,
          endSec: 2,
          assetId: "asset-1",
          kind: "image" as const,
        },
        {
          id: "broken-clip",
          label: "Broken",
          startSec: 5,
          endSec: 1,
          assetId: "asset-1",
        },
      ],
    };
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([corruptRaw]));

    const repaired = await repairCorruptProjectTimeline(corruptRaw.id);
    expect(repaired.timeline).toHaveLength(1);
    expect(repaired.timeline?.[0].id).toBe("good-clip");
    expect(loadStoredProjectsStrict()).toHaveLength(1);
    expect(partitionStoredProjects().corrupt).toHaveLength(0);
  });
});
