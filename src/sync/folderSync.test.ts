import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyConflictResolutions,
  detectFolderConflicts,
  dropRedundantFolderOps,
  prepareOpsForUpload,
  syncLibraryFolders,
  LIBRARY_FOLDER_OPS_MAX,
} from "./folderSync";
import type { FolderSyncState, PendingFolderOp } from "../library/folderClient";
import {
  LibraryFoldersConflictError,
  type LibraryFolderOperation,
  type RemoteLibraryFolder,
} from "../sdk/parascene";

const getFolderSyncState = vi.fn();
const applyFolderSnapshot = vi.fn();
const ackFolderOps = vi.fn();
const setFolderPendingOps = vi.fn();
const pullLibraryFoldersSnapshot = vi.fn();
const mutateLibraryFoldersSnapshot = vi.fn();

vi.mock("../library/folderClient", async () => {
  const actual = await vi.importActual<typeof import("../library/folderClient")>(
    "../library/folderClient",
  );
  return {
    ...actual,
    getFolderSyncState: (...args: unknown[]) => getFolderSyncState(...args),
    applyFolderSnapshot: (...args: unknown[]) => applyFolderSnapshot(...args),
    ackFolderOps: (...args: unknown[]) => ackFolderOps(...args),
    setFolderPendingOps: (...args: unknown[]) => setFolderPendingOps(...args),
  };
});

vi.mock("../services/folderSyncApi", () => ({
  pullLibraryFoldersSnapshot: (...args: unknown[]) =>
    pullLibraryFoldersSnapshot(...args),
  mutateLibraryFoldersSnapshot: (...args: unknown[]) =>
    mutateLibraryFoldersSnapshot(...args),
}));

vi.mock("../auth/session", () => ({
  ensureAccessToken: vi.fn(async () => "tok"),
}));

function remoteFolder(
  partial: Partial<RemoteLibraryFolder> & { id: string },
): RemoteLibraryFolder {
  return {
    title: "Folder",
    description: "",
    created_at: "2026-07-18T00:00:00.000Z",
    updated_at: "2026-07-18T00:00:00.000Z",
    creation_ids: [],
    member_count: 0,
    meta: {},
    ...partial,
  };
}

function state(partial: Partial<FolderSyncState>): FolderSyncState {
  return {
    revision: null,
    pendingOps: [],
    folders: [],
    baselineFolders: [],
    ...partial,
  };
}

function pending(
  seq: number,
  op: LibraryFolderOperation,
): PendingFolderOp {
  return { seq, op, createdAt: "2026-07-18T00:00:00.000Z" };
}

describe("folderSync helpers", () => {
  it("detects folder meta conflicts via three-way compare", () => {
    const baseline = [
      {
        id: "f1",
        title: "Old",
        description: "",
        createdAt: null,
        updatedAt: null,
        creationIds: [],
        memberCount: 0,
      },
    ];
    const cloud = [remoteFolder({ id: "f1", title: "Cloud" })];
    const ops = [
      pending(1, { op: "update", id: "f1", title: "Local", description: "" }),
    ];
    const conflicts = detectFolderConflicts(baseline, cloud, ops);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("folder_meta");
  });

  it("detects creation move conflicts", () => {
    const baseline = [
      {
        id: "a",
        title: "A",
        description: "",
        createdAt: null,
        updatedAt: null,
        creationIds: ["10"],
        memberCount: 1,
      },
    ];
    const cloud = [
      remoteFolder({ id: "a", title: "A", creation_ids: [] }),
      remoteFolder({ id: "b", title: "B", creation_ids: [10] }),
    ];
    const ops = [
      pending(1, { op: "move", folder_id: null, creation_ids: [10] }),
    ];
    const conflicts = detectFolderConflicts(baseline, cloud, ops);
    expect(conflicts.some((c) => c.kind === "creation_move")).toBe(true);
  });

  it("detects delete vs edit conflicts", () => {
    const baseline = [
      {
        id: "f1",
        title: "Old",
        description: "",
        createdAt: null,
        updatedAt: null,
        creationIds: [],
        memberCount: 0,
      },
    ];
    const cloud = [remoteFolder({ id: "f1", title: "Edited in cloud" })];
    const ops = [pending(1, { op: "delete", id: "f1" })];
    const conflicts = detectFolderConflicts(baseline, cloud, ops);
    expect(conflicts[0]?.kind).toBe("delete_vs_edit");
  });

  it("does not treat a never-uploaded folder update as deleted in the cloud", () => {
    const folderId = "11111111-1111-4111-8111-111111111111";
    const cloud: RemoteLibraryFolder[] = [];
    const ops = [
      pending(1, {
        op: "create",
        id: folderId,
        title: "Untitled project",
        description: "",
      }),
      pending(2, {
        op: "update",
        id: folderId,
        title: "Renamed project",
        description: "",
      }),
    ];
    expect(detectFolderConflicts([], cloud, ops)).toEqual([]);
  });

  it("still detects remote delete when a known folder disappears under a local update", () => {
    const folderId = "11111111-1111-4111-8111-111111111111";
    const baseline = [
      {
        id: folderId,
        title: "Known",
        description: "",
        createdAt: null,
        updatedAt: null,
        creationIds: [],
        memberCount: 0,
      },
    ];
    const ops = [
      pending(1, {
        op: "update",
        id: folderId,
        title: "Local rename",
        description: "",
      }),
    ];
    const conflicts = detectFolderConflicts(baseline, [], ops);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("delete_vs_edit");
    expect(conflicts[0]?.cloudLabel).toBe("Deleted in cloud");
  });

  it("allows safe concurrent updates on different folders", () => {
    const baseline = [
      {
        id: "a",
        title: "A",
        description: "",
        createdAt: null,
        updatedAt: null,
        creationIds: [],
        memberCount: 0,
      },
      {
        id: "b",
        title: "B",
        description: "",
        createdAt: null,
        updatedAt: null,
        creationIds: [],
        memberCount: 0,
      },
    ];
    const cloud = [
      remoteFolder({ id: "a", title: "A-cloud" }),
      remoteFolder({ id: "b", title: "B" }),
    ];
    const ops = [
      pending(1, { op: "update", id: "b", title: "B-local", description: "" }),
    ];
    expect(detectFolderConflicts(baseline, cloud, ops)).toEqual([]);
  });

  it("applies cloud resolutions by dropping conflicting pending ops", () => {
    const pendingOps = [
      pending(1, { op: "update", id: "f1", title: "Local" }),
      pending(2, { op: "move", folder_id: "f2", creation_ids: [1, 2] }),
    ];
    const conflicts = [
      {
        id: "folder_meta:f1",
        kind: "folder_meta" as const,
        summary: "x",
        folderId: "f1",
        localLabel: "Local",
        cloudLabel: "Cloud",
      },
      {
        id: "creation_move:1",
        kind: "creation_move" as const,
        summary: "y",
        creationId: "1",
        localLabel: "L",
        cloudLabel: "C",
      },
    ];
    const kept = applyConflictResolutions(pendingOps, conflicts, {
      "folder_meta:f1": "cloud",
      "creation_move:1": "cloud",
    });
    expect(kept).toEqual([
      { op: "move", folder_id: "f2", creation_ids: [2] },
    ]);
  });

  it("batches ops at the API limit", () => {
    const pendingOps = Array.from({ length: LIBRARY_FOLDER_OPS_MAX + 5 }, (_, i) =>
      pending(i + 1, { op: "delete", id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }),
    );
    const { ops } = prepareOpsForUpload(pendingOps);
    expect(ops.length).toBe(LIBRARY_FOLDER_OPS_MAX + 5);
  });

  it("upgrades legacy project claims and preserves ownership assertions", () => {
    const legacyClaim = {
      op: "claim_project",
      id: "11111111-1111-4111-8111-111111111111",
      title: "Project",
      project_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    } as unknown as LibraryFolderOperation;
    const { ops } = prepareOpsForUpload([pending(1, legacyClaim)]);
    expect(ops).toEqual([
      {
        op: "update",
        id: "11111111-1111-4111-8111-111111111111",
        title: "Project",
        meta: {
          parascene_desktop: {
            project_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          },
        },
        project_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    ]);
  });

  it("does not conflict when a pending create id already exists on cloud", () => {
    const folderId = "11111111-1111-4111-8111-111111111111";
    const cloud = [remoteFolder({ id: folderId, title: "Cloud title" })];
    const ops = [
      pending(1, {
        op: "create",
        id: folderId,
        title: "Local title",
        description: "",
      }),
      pending(2, {
        op: "update",
        id: folderId,
        title: "Local title",
        description: "",
      }),
    ];
    expect(detectFolderConflicts([], cloud, ops)).toEqual([]);
  });
});

describe("dropRedundantFolderOps", () => {
  it("drops create when cloud already has the folder id", () => {
    const folderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const pendingOps = [
      pending(1, { op: "create", id: folderId, title: "Mine" }),
      pending(2, { op: "update", id: folderId, title: "Renamed" }),
      pending(3, { op: "move", folder_id: folderId, creation_ids: [1] }),
    ];
    const { kept, dropped } = dropRedundantFolderOps(pendingOps, [
      remoteFolder({ id: folderId, title: "Mine" }),
    ]);
    expect(dropped.map((row) => row.op.op)).toEqual(["create"]);
    expect(kept.map((row) => row.op.op)).toEqual(["update", "move"]);
  });

  it("keeps create when a pending delete targets the same id (release)", () => {
    const folderId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const pendingOps = [
      pending(1, { op: "delete", id: folderId, project_id: projectId }),
      pending(2, {
        op: "create",
        id: folderId,
        title: "Released",
        meta: {},
      }),
    ];
    const { kept, dropped } = dropRedundantFolderOps(pendingOps, [
      remoteFolder({
        id: folderId,
        title: "Released",
        meta: { parascene_desktop: { project_id: projectId } },
      }),
    ]);
    expect(dropped).toEqual([]);
    expect(kept.map((row) => row.op.op)).toEqual(["delete", "create"]);
  });

  it("drops delete when the folder is already absent from cloud", () => {
    const folderId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const pendingOps = [
      pending(1, { op: "delete", id: folderId, project_id: "p" }),
      pending(2, {
        op: "create",
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        title: "New",
      }),
    ];
    const { kept, dropped } = dropRedundantFolderOps(pendingOps, []);
    expect(dropped.map((row) => row.op.op)).toEqual(["delete"]);
    expect(kept.map((row) => row.op.op)).toEqual(["create"]);
  });
});

describe("syncLibraryFolders", () => {
  beforeEach(() => {
    getFolderSyncState.mockReset();
    applyFolderSnapshot.mockReset();
    ackFolderOps.mockReset();
    setFolderPendingOps.mockReset();
    pullLibraryFoldersSnapshot.mockReset();
    mutateLibraryFoldersSnapshot.mockReset();
  });

  it("installs cloud snapshot when there are no pending ops", async () => {
    const empty = state({ revision: 1 });
    const after = state({ revision: 3, folders: [] });
    getFolderSyncState.mockResolvedValue(empty);
    pullLibraryFoldersSnapshot.mockResolvedValue({
      revision: 3,
      folders: [remoteFolder({ id: "f1", title: "Cloud" })],
    });
    applyFolderSnapshot.mockResolvedValue(after);

    const result = await syncLibraryFolders();
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(3);
    expect(applyFolderSnapshot).toHaveBeenCalledWith(
      3,
      expect.arrayContaining([
        expect.objectContaining({ id: "f1", title: "Cloud" }),
      ]),
    );
    expect(mutateLibraryFoldersSnapshot).not.toHaveBeenCalled();
  });

  it("uploads project repairs generated while applying a cloud snapshot", async () => {
    const folderId = "11111111-1111-4111-8111-111111111111";
    const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const repair = pending(9, {
      op: "update",
      id: folderId,
      title: "Local project",
      meta: { parascene_desktop: { project_id: projectId } },
      project_id: projectId,
    });
    getFolderSyncState
      .mockResolvedValueOnce(state({ revision: 1 }))
      .mockResolvedValueOnce(state({ revision: 3, pendingOps: [] }));
    pullLibraryFoldersSnapshot.mockResolvedValue({
      revision: 2,
      folders: [remoteFolder({ id: folderId, title: "Ordinary cloud folder" })],
    });
    applyFolderSnapshot
      .mockResolvedValueOnce(state({ revision: 2, pendingOps: [repair] }))
      .mockResolvedValueOnce(state({ revision: 3, pendingOps: [repair] }));
    mutateLibraryFoldersSnapshot.mockResolvedValue({
      revision: 3,
      folders: [
        remoteFolder({
          id: folderId,
          title: "Local project",
          meta: { parascene_desktop: { project_id: projectId } },
        }),
      ],
    });
    ackFolderOps.mockResolvedValue(state({ revision: 3, pendingOps: [] }));

    const result = await syncLibraryFolders();
    expect(result.ok).toBe(true);
    expect(mutateLibraryFoldersSnapshot).toHaveBeenCalledWith({
      baseRevision: 2,
      operations: [repair.op],
    });
    expect(ackFolderOps).toHaveBeenCalledWith([9]);
  });

  it("uploads pending ops and acks on success", async () => {
    const folderId = "11111111-1111-4111-8111-111111111111";
    const initial = state({
      revision: 2,
      pendingOps: [
        pending(7, {
          op: "create",
          id: folderId,
          title: "B-roll",
          creation_ids: [103],
        }),
      ],
      baselineFolders: [],
    });
    getFolderSyncState
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(state({ revision: 3, pendingOps: [] }));
    pullLibraryFoldersSnapshot.mockResolvedValue({ revision: 2, folders: [] });
    mutateLibraryFoldersSnapshot.mockResolvedValue({
      revision: 3,
      folders: [remoteFolder({ id: folderId, title: "B-roll", creation_ids: [103] })],
    });
    applyFolderSnapshot.mockResolvedValue(
      state({ revision: 3, pendingOps: initial.pendingOps }),
    );
    ackFolderOps.mockResolvedValue(state({ revision: 3, pendingOps: [] }));

    const result = await syncLibraryFolders();
    expect(result.ok).toBe(true);
    expect(result.uploadedBatches).toBe(1);
    expect(mutateLibraryFoldersSnapshot).toHaveBeenCalledWith({
      baseRevision: 2,
      operations: [
        expect.objectContaining({
          op: "create",
          id: folderId,
          title: "B-roll",
        }),
      ],
    });
    expect(ackFolderOps).toHaveBeenCalledWith([7]);
  });

  it("returns conflicts instead of forcing overwrite", async () => {
    const folderId = "11111111-1111-4111-8111-111111111111";
    const initial = state({
      revision: 1,
      baselineFolders: [
        {
          id: folderId,
          title: "Old",
          description: "",
          createdAt: null,
          updatedAt: null,
          creationIds: [],
          memberCount: 0,
        },
      ],
      pendingOps: [
        pending(1, {
          op: "update",
          id: folderId,
          title: "Local",
          description: "",
        }),
      ],
    });
    getFolderSyncState
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({
        ...initial,
        revision: 2,
        baselineFolders: [
          {
            id: folderId,
            title: "Cloud",
            description: "",
            createdAt: null,
            updatedAt: null,
            creationIds: [],
            memberCount: 0,
          },
        ],
      });
    pullLibraryFoldersSnapshot.mockResolvedValue({
      revision: 2,
      folders: [remoteFolder({ id: folderId, title: "Cloud" })],
    });
    applyFolderSnapshot.mockResolvedValue(
      state({
        revision: 2,
        pendingOps: initial.pendingOps,
      }),
    );

    const result = await syncLibraryFolders();
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(mutateLibraryFoldersSnapshot).not.toHaveBeenCalled();
  });

  it("retries after a 409 when the merge is safe", async () => {
    const folderId = "22222222-2222-4222-8222-222222222222";
    const pendingOps = [
      pending(3, { op: "create", id: folderId, title: "Mine" }),
    ];
    const initial = state({
      revision: 1,
      pendingOps,
      baselineFolders: [],
    });
    getFolderSyncState
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(state({ revision: 2, pendingOps }))
      .mockResolvedValueOnce(state({ revision: 3, pendingOps: [] }));
    pullLibraryFoldersSnapshot.mockResolvedValue({
      revision: 1,
      folders: [],
    });
    mutateLibraryFoldersSnapshot
      .mockRejectedValueOnce(
        new LibraryFoldersConflictError({
          revision: 2,
          folders: [remoteFolder({ id: "other", title: "Other" })],
        }),
      )
      .mockResolvedValueOnce({
        revision: 3,
        folders: [
          remoteFolder({ id: "other", title: "Other" }),
          remoteFolder({ id: folderId, title: "Mine" }),
        ],
      });
    applyFolderSnapshot.mockImplementation(async (revision: number) =>
      state({ revision, pendingOps }),
    );
    ackFolderOps.mockResolvedValue(state({ revision: 3, pendingOps: [] }));

    const result = await syncLibraryFolders();
    expect(result.ok).toBe(true);
    expect(mutateLibraryFoldersSnapshot).toHaveBeenCalledTimes(2);
  });

  it("drops stuck unowned empty-meta clears and restores cloud project folders", async () => {
    const folderId = "11111111-1111-4111-8111-111111111111";
    const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const stuck = pending(3, {
      op: "update",
      id: folderId,
      title: "Untitled project",
      meta: {},
    });
    const initial = state({
      revision: 2,
      pendingOps: [stuck],
      baselineFolders: [],
    });
    getFolderSyncState
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(state({ revision: 2, pendingOps: [] }));
    pullLibraryFoldersSnapshot.mockResolvedValue({
      revision: 2,
      folders: [
        remoteFolder({
          id: folderId,
          title: "Untitled project",
          meta: { parascene_desktop: { project_id: projectId } },
        }),
      ],
    });
    setFolderPendingOps.mockResolvedValue(state({ revision: 2, pendingOps: [] }));
    applyFolderSnapshot.mockResolvedValue(
      state({
        revision: 2,
        pendingOps: [],
        folders: [
          {
            id: folderId,
            title: "Untitled project",
            description: "",
            createdAt: "t",
            updatedAt: "t",
            memberIds: [],
            memberCount: 0,
            kind: "project",
            projectId,
          },
        ],
      }),
    );

    const result = await syncLibraryFolders();
    expect(result.ok).toBe(true);
    expect(setFolderPendingOps).toHaveBeenCalledWith([]);
    expect(mutateLibraryFoldersSnapshot).not.toHaveBeenCalled();
  });

  it("expands owned marker clears to delete+create before upload", async () => {
    const folderId = "11111111-1111-4111-8111-111111111111";
    const projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const clearOp = pending(4, {
      op: "update",
      id: folderId,
      title: "Orphan",
      meta: {},
      project_id: projectId,
    });
    getFolderSyncState
      .mockResolvedValueOnce(
        state({ revision: 1, pendingOps: [clearOp], baselineFolders: [] }),
      )
      .mockResolvedValueOnce(state({ revision: 2, pendingOps: [] }));
    pullLibraryFoldersSnapshot.mockResolvedValue({
      revision: 1,
      folders: [
        remoteFolder({
          id: folderId,
          title: "Orphan",
          creation_ids: [101],
          meta: { parascene_desktop: { project_id: projectId } },
        }),
      ],
    });
    setFolderPendingOps.mockImplementation(async (ops) =>
      state({
        revision: 1,
        pendingOps: ops.map((op: LibraryFolderOperation, i: number) =>
          pending(200 + i, op),
        ),
        baselineFolders: [],
        folders: [
          {
            id: folderId,
            title: "Orphan",
            description: "",
            createdAt: "t",
            updatedAt: "t",
            memberIds: ["101"],
            memberCount: 1,
            kind: "regular",
            projectId: null,
          },
        ],
      }),
    );
    applyFolderSnapshot.mockResolvedValue(
      state({ revision: 2, pendingOps: [] }),
    );
    mutateLibraryFoldersSnapshot.mockResolvedValue({
      revision: 2,
      folders: [remoteFolder({ id: folderId, title: "Orphan", creation_ids: [101], meta: {} })],
    });
    ackFolderOps.mockResolvedValue(state({ revision: 2, pendingOps: [] }));

    const result = await syncLibraryFolders();
    expect(result.ok).toBe(true);
    expect(mutateLibraryFoldersSnapshot).toHaveBeenCalledWith({
      baseRevision: 1,
      operations: [
        expect.objectContaining({
          op: "delete",
          id: folderId,
          project_id: projectId,
        }),
        expect.objectContaining({
          op: "create",
          id: folderId,
          title: "Orphan",
          meta: {},
          creation_ids: [101],
        }),
      ],
    });
  });

  it("drops stuck create when cloud already has the folder and uploads remaining ops", async () => {
    const folderId = "a0d03fda-1546-4ffd-9465-987298887ebe";
    const createOp = pending(1, {
      op: "create",
      id: folderId,
      title: "Project (2 assets)",
    });
    const updateOp = pending(2, {
      op: "update",
      id: folderId,
      title: "Silent Killer",
    });
    const moveOp = pending(3, {
      op: "move",
      folder_id: folderId,
      creation_ids: [42],
    });
    const initialPending = [createOp, updateOp, moveOp];
    const healedPending = [updateOp, moveOp];

    getFolderSyncState
      .mockResolvedValueOnce(
        state({
          revision: 9,
          pendingOps: initialPending,
          baselineFolders: [],
        }),
      )
      .mockResolvedValueOnce(
        state({ revision: 10, pendingOps: [] }),
      );
    pullLibraryFoldersSnapshot.mockResolvedValue({
      revision: 9,
      folders: [remoteFolder({ id: folderId, title: "Project (2 assets)" })],
    });
    setFolderPendingOps.mockResolvedValue(
      state({ revision: 9, pendingOps: healedPending, baselineFolders: [] }),
    );
    applyFolderSnapshot.mockResolvedValue(
      state({ revision: 10, pendingOps: healedPending }),
    );
    mutateLibraryFoldersSnapshot.mockResolvedValue({
      revision: 10,
      folders: [remoteFolder({ id: folderId, title: "Silent Killer", creation_ids: [42] })],
    });
    ackFolderOps.mockResolvedValue(state({ revision: 10, pendingOps: [] }));

    const result = await syncLibraryFolders();
    expect(result.ok).toBe(true);
    expect(setFolderPendingOps).toHaveBeenCalledWith([
      expect.objectContaining({ op: "update", id: folderId, title: "Silent Killer" }),
      expect.objectContaining({ op: "move", folder_id: folderId }),
    ]);
    expect(mutateLibraryFoldersSnapshot).toHaveBeenCalledWith({
      baseRevision: 9,
      operations: [
        expect.objectContaining({ op: "update", id: folderId, title: "Silent Killer" }),
        expect.objectContaining({ op: "move", folder_id: folderId }),
      ],
    });
    expect(
      mutateLibraryFoldersSnapshot.mock.calls[0]![0].operations.some(
        (op: LibraryFolderOperation) => op.op === "create",
      ),
    ).toBe(false);
  });

  it("heals after folder id already exists mutate error then retries", async () => {
    const folderId = "a0d03fda-1546-4ffd-9465-987298887ebe";
    const createOp = pending(1, {
      op: "create",
      id: folderId,
      title: "Project (2 assets)",
    });
    const updateOp = pending(2, {
      op: "update",
      id: folderId,
      title: "Silent Killer",
    });
    const pendingOps = [createOp, updateOp];

    getFolderSyncState
      .mockResolvedValueOnce(
        state({ revision: 9, pendingOps, baselineFolders: [] }),
      )
      // After failed mutate re-pull + getFolderSyncState
      .mockResolvedValueOnce(
        state({ revision: 9, pendingOps, baselineFolders: [] }),
      )
      .mockResolvedValueOnce(state({ revision: 10, pendingOps: [] }));

    pullLibraryFoldersSnapshot
      // Initial pull — cloud empty so create is not dropped pre-upload
      .mockResolvedValueOnce({ revision: 9, folders: [] })
      // Re-pull after error — folder now on cloud
      .mockResolvedValueOnce({
        revision: 9,
        folders: [remoteFolder({ id: folderId, title: "Project (2 assets)" })],
      });

    mutateLibraryFoldersSnapshot
      .mockRejectedValueOnce(new Error("folder id already exists"))
      .mockResolvedValueOnce({
        revision: 10,
        folders: [remoteFolder({ id: folderId, title: "Silent Killer" })],
      });

    applyFolderSnapshot.mockImplementation(async (revision: number) =>
      state({
        revision,
        pendingOps:
          revision === 10 ? [updateOp] : pendingOps,
      }),
    );
    setFolderPendingOps.mockResolvedValue(
      state({ revision: 9, pendingOps: [updateOp], baselineFolders: [] }),
    );
    ackFolderOps.mockResolvedValue(state({ revision: 10, pendingOps: [] }));

    const result = await syncLibraryFolders();
    expect(result.ok).toBe(true);
    expect(mutateLibraryFoldersSnapshot).toHaveBeenCalledTimes(2);
    expect(mutateLibraryFoldersSnapshot.mock.calls[1]![0].operations).toEqual([
      expect.objectContaining({ op: "update", id: folderId, title: "Silent Killer" }),
    ]);
  });

  it("still uploads delete+create release when cloud still has the project folder", async () => {
    const folderId = "a9941ef5-5138-457b-ac70-d2b29d807d7d";
    const projectId = "16fba4e5-d353-4707-b5f4-f9d29c6a645d";
    const pendingOps = [
      pending(1, { op: "delete", id: folderId, project_id: projectId }),
      pending(2, {
        op: "create",
        id: folderId,
        title: "Sana Sinabi Ko Na",
        meta: {},
      }),
    ];
    getFolderSyncState
      .mockResolvedValueOnce(
        state({ revision: 9, pendingOps, baselineFolders: [] }),
      )
      .mockResolvedValueOnce(state({ revision: 10, pendingOps: [] }));
    pullLibraryFoldersSnapshot.mockResolvedValue({
      revision: 9,
      folders: [
        remoteFolder({
          id: folderId,
          title: "Sana Sinabi Ko Na",
          meta: { parascene_desktop: { project_id: projectId } },
        }),
      ],
    });
    applyFolderSnapshot.mockResolvedValue(
      state({ revision: 10, pendingOps: [] }),
    );
    mutateLibraryFoldersSnapshot.mockResolvedValue({
      revision: 10,
      folders: [
        remoteFolder({ id: folderId, title: "Sana Sinabi Ko Na", meta: {} }),
      ],
    });
    ackFolderOps.mockResolvedValue(state({ revision: 10, pendingOps: [] }));

    const result = await syncLibraryFolders();
    expect(result.ok).toBe(true);
    expect(mutateLibraryFoldersSnapshot).toHaveBeenCalledWith({
      baseRevision: 9,
      operations: [
        expect.objectContaining({
          op: "delete",
          id: folderId,
          project_id: projectId,
        }),
        expect.objectContaining({
          op: "create",
          id: folderId,
          title: "Sana Sinabi Ko Na",
          meta: {},
        }),
      ],
    });
  });
});
