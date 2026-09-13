import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryFolder } from "../library/folderClient";

const native = vi.hoisted(() => ({
  existingCreationIds: vi.fn<(ids: string[]) => Promise<string[]>>(),
  getCreations: vi.fn(),
  markProjectUsageStale: vi.fn<
    (
      projectId: string,
      expectedDocumentRevision: string | null,
      nextDocumentRevision: string,
      allowExistingStale?: boolean,
    ) => Promise<void>
  >(),
  repairProjectUsage: vi.fn<() => Promise<void>>(),
  replaceProjectUsage: vi.fn<() => Promise<void>>(),
  listFolders: vi.fn<() => Promise<LibraryFolder[]>>(),
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

vi.mock("../library/folderClient", () => ({
  listFolders: native.listFolders,
}));

import {
  PROJECTS_STORAGE_KEY,
  createStoredProject,
  loadStoredProjectsStrict,
  partitionStoredProjects,
  resetProjectStoreForTests,
  saveStoredProjects,
  setStoredProjectSelectedAssetId,
  upsertStoredLibraryAssetPlaceholder,
} from "./projectStore";
import {
  mirrorStoredProjectsAfterNativeMembership,
  mutateStoredProjects,
  repairCorruptProjectTimeline,
} from "./projectMutationCoordinator";
import { MEMBERSHIP_MIRROR_STALE_MESSAGE } from "./projectFolderMembership";
import { collectProjectAssetUsage } from "./projectUsage";

function projectFolder(
  projectId: string,
  memberIds: string[],
): LibraryFolder {
  return {
    id: `folder-${projectId}`,
    title: "Folder",
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memberIds,
    memberCount: memberIds.length,
    kind: "project",
    projectId,
  };
}

describe("projectMutationCoordinator", () => {
  beforeEach(() => {
    resetProjectStoreForTests();
    localStorage.removeItem(PROJECTS_STORAGE_KEY);
    vi.clearAllMocks();
    native.existingCreationIds.mockImplementation(async (ids) => ids);
    native.getCreations.mockResolvedValue([]);
    native.markProjectUsageStale.mockResolvedValue();
    native.repairProjectUsage.mockResolvedValue();
    native.replaceProjectUsage.mockResolvedValue();
    native.listFolders.mockResolvedValue([]);
  });

  it("drops a newly owned creation that disappeared before the document commit", async () => {
    const project = { ...createStoredProject("Race"), lifecycle: "ready" as const };
    saveStoredProjects([project]);
    native.existingCreationIds.mockResolvedValue([]);

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({ ...row, creationIds: ["deleted-result"] })),
    );

    expect(next[0].creationIds).toEqual([]);
    expect(loadStoredProjectsStrict()[0].creationIds).toEqual([]);
  });

  it("keeps a cataloged generate result when a sibling id is still missing", async () => {
    const project = { ...createStoredProject("Race"), lifecycle: "ready" as const };
    saveStoredProjects([project]);
    native.existingCreationIds.mockImplementation(async (ids) =>
      ids.filter((id) => id === "music-1"),
    );

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({
        ...row,
        creationIds: ["music-1", "296610"],
      })),
    );

    expect(next[0].creationIds).toEqual(["music-1"]);
    expect(loadStoredProjectsStrict()[0].creationIds).toEqual(["music-1"]);
  });

  it("allows a framed start still that is not yet an Assets tile", async () => {
    const project = {
      ...createStoredProject("TestProject", ["still-1"]),
      lifecycle: "ready" as const,
    };
    saveStoredProjects([project]);

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({
        ...row,
        creationIds: ["still-1", "296620"],
        timeline: [
          {
            id: "clip-1",
            label: "0:12",
            startSec: 0,
            endSec: 11.9,
            assetId: "296620",
            kind: "video" as const,
            addAssetGeneration: {
              prompt: "go",
              generatedAt: "2026-01-01T00:00:00.000Z",
              creationId: "296620",
              startFrameAssetId: "296611",
              firstFrameSource: { kind: "asset" as const, assetId: "296611" },
            },
          },
        ],
      })),
    );

    expect(next[0].creationIds).toEqual(["still-1", "296620"]);
    expect(next[0].timeline?.[0].addAssetGeneration?.startFrameAssetId).toBe(
      "296611",
    );
  });

  it("allows an in-flight pending creation that is not in the folder yet", async () => {
    const project = {
      ...createStoredProject("TestProject", ["still-1"]),
      lifecycle: "ready" as const,
    };
    saveStoredProjects([project]);

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({
        ...row,
        timeline: [
          {
            id: "clip-1",
            label: "0:12",
            startSec: 0,
            endSec: 11.9,
            assetId: "",
            kind: "video" as const,
            isAddAssetPlaceholder: true,
            addAssetDraft: {
              prompt: "go",
              generationJob: {
                status: "waiting" as const,
                provider: "parascene_blue" as const,
                startedAt: "2026-01-01T00:00:00.000Z",
                pendingCreationId: "296611",
              },
            },
            addAssetGeneration: {
              prompt: "go",
              generatedAt: "2026-01-01T00:00:00.000Z",
              creationId: "296611",
            },
          },
        ],
      })),
    );

    expect(next[0].timeline?.[0].addAssetGeneration?.creationId).toBe("296611");
  });

  it("rejects when a missing Library file is still referenced on the timeline", async () => {
    const project = { ...createStoredProject("Race"), lifecycle: "ready" as const };
    saveStoredProjects([project]);
    native.existingCreationIds.mockResolvedValue([]);

    await expect(
      mutateStoredProjects((projects) =>
        projects.map((row) => ({
          ...row,
          creationIds: ["296610"],
          timeline: [
            {
              id: "clip-1",
              label: "9.0s",
              startSec: 0,
              endSec: 9,
              assetId: "296610",
              kind: "video" as const,
            },
          ],
        })),
      ),
    ).rejects.toThrow("296610");

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

  it("does not veto a v2 save when a timeline ref is outside membership", async () => {
    const project = {
      ...createStoredProject("TestProject", ["owned"]),
      containerVersion: "v2" as const,
      parasceneProjectId: "44",
      lifecycle: "ready" as const,
    };
    saveStoredProjects([project]);

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({
        ...row,
        timeline: [
          {
            id: "clip-1",
            label: "11.9s",
            startSec: 0,
            endSec: 11.9,
            assetId: "296611",
            kind: "video" as const,
          },
        ],
      })),
    );

    expect(next[0].creationIds).toEqual(["owned"]);
    expect(next[0].timeline?.[0].assetId).toBe("296611");
  });

  it("does not veto a v2 save when another membership id is still missing", async () => {
    const project = {
      ...createStoredProject("TestProject", ["music-1"]),
      containerVersion: "v2" as const,
      parasceneProjectId: "44",
      lifecycle: "ready" as const,
      timeline: [
        {
          id: "clip-1",
          label: "theme",
          startSec: 0,
          endSec: 8,
          assetId: "296610",
          kind: "audio" as const,
        },
      ],
    };
    saveStoredProjects([project]);
    native.existingCreationIds.mockImplementation(async (ids) =>
      ids.filter((id) => id !== "296610"),
    );

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({
        ...row,
        creationIds: ["music-1", "296610"],
      })),
    );

    expect(next[0].creationIds).toEqual(["music-1"]);
    expect(next[0].timeline?.[0].assetId).toBe("296610");
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

  it("allows a cabinet pointer that is not yet in creationIds", async () => {
    const project = {
      ...createStoredProject("GenerateAudio", ["still-1"]),
      lifecycle: "ready" as const,
      imagesGroupId: "28547",
    };
    saveStoredProjects([project]);

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({
        ...row,
        creationIds: ["still-1", "still-2"],
      })),
    );

    expect(next[0].imagesGroupId).toBe("28547");
    expect(next[0].creationIds).toEqual(["still-1", "still-2"]);
  });

  it("allows hiding a dead cover after the Images pointer is cleared", async () => {
    const project = {
      ...createStoredProject("GenerateAudio", ["28547", "still-1"]),
      lifecycle: "ready" as const,
      imagesGroupId: "28547",
    };
    saveStoredProjects([project]);

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({
        ...row,
        imagesGroupId: null,
        creationIds: ["still-1"],
      })),
    );

    expect(next[0].imagesGroupId).toBeNull();
    expect(next[0].creationIds).toEqual(["still-1"]);
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

  it("does not block a save when an existing timeline ref loses folder membership", async () => {
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

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({ ...row, creationIds: ["owned"] })),
    );

    expect(next[0].creationIds).toEqual(["owned"]);
    expect(next[0].timeline?.[0].assetId).toBe("still-used");
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

    native.listFolders.mockResolvedValue([
      projectFolder(project.id, ["owned"]),
    ]);
    const next = await mirrorStoredProjectsAfterNativeMembership();

    expect(next[0].creationIds).toEqual(["owned"]);
    expect(
      collectProjectAssetUsage(next[0]).some(
        (row) => row.creationId === "still-used",
      ),
    ).toBe(true);
    expect(native.replaceProjectUsage).toHaveBeenCalled();
  });

  it("remirrors folder membership and retries instead of failing a document save", async () => {
    const project = {
      ...createStoredProject("Live Cut", ["old-cover"]),
      lifecycle: "ready" as const,
    };
    saveStoredProjects([project]);
    native.markProjectUsageStale
      .mockRejectedValueOnce(new Error(MEMBERSHIP_MIRROR_STALE_MESSAGE))
      .mockResolvedValue(undefined);
    native.listFolders.mockResolvedValue([
      projectFolder(project.id, ["videos-cover"]),
    ]);

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({ ...row, title: "Live Cut retitled" })),
    );

    expect(next[0].title).toBe("Live Cut retitled");
    expect(next[0].creationIds).toEqual(["videos-cover"]);
    expect(native.markProjectUsageStale).toHaveBeenCalledTimes(2);
    expect(native.markProjectUsageStale.mock.calls[1]?.[3]).toBe(true);
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

  it("persists in-flight library placeholders without requiring a catalog row", async () => {
    const project = {
      ...createStoredProject("Demo", ["c1"]),
      lifecycle: "ready" as const,
    };
    saveStoredProjects([project]);

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => {
        if (row.id !== project.id) return row;
        const withPlaceholder = upsertStoredLibraryAssetPlaceholder(row, {
          id: "placeholder-1",
          kind: "image",
          aspectRatio: "16:9",
          status: "generating",
          addAssetDraft: {
            prompt: "sunset",
            intentId: "text_to_image",
            server: "parascene_blue",
            provider: "parascene_blue",
            methodId: "text_to_image",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        return setStoredProjectSelectedAssetId(
          withPlaceholder,
          "placeholder-1",
        );
      }),
    );

    expect(next[0].creationIds).toEqual(["c1"]);
    expect(next[0].libraryAssetPlaceholders?.["placeholder-1"]?.id).toBe(
      "placeholder-1",
    );
    expect(next[0].selectedAssetId).toBe("placeholder-1");
    expect(native.existingCreationIds).not.toHaveBeenCalled();
  });
});
