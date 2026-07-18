import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyConflictResolutions,
  detectFolderConflicts,
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
const getLibraryFolders = vi.fn();
const mutateLibraryFolders = vi.fn();

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

vi.mock("../auth/session", () => ({
  ensureAccessToken: vi.fn(async () => "tok"),
  createAuthedSdk: () => ({
    getLibraryFolders: (...args: unknown[]) => getLibraryFolders(...args),
    mutateLibraryFolders: (...args: unknown[]) => mutateLibraryFolders(...args),
  }),
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
});

describe("syncLibraryFolders", () => {
  beforeEach(() => {
    getFolderSyncState.mockReset();
    applyFolderSnapshot.mockReset();
    ackFolderOps.mockReset();
    setFolderPendingOps.mockReset();
    getLibraryFolders.mockReset();
    mutateLibraryFolders.mockReset();
  });

  it("installs cloud snapshot when there are no pending ops", async () => {
    const empty = state({ revision: 1 });
    const after = state({ revision: 3, folders: [] });
    getFolderSyncState.mockResolvedValue(empty);
    getLibraryFolders.mockResolvedValue({
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
    expect(mutateLibraryFolders).not.toHaveBeenCalled();
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
    getLibraryFolders.mockResolvedValue({ revision: 2, folders: [] });
    mutateLibraryFolders.mockResolvedValue({
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
    expect(mutateLibraryFolders).toHaveBeenCalledWith({
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
    getLibraryFolders.mockResolvedValue({
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
    expect(mutateLibraryFolders).not.toHaveBeenCalled();
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
    getLibraryFolders.mockResolvedValue({
      revision: 1,
      folders: [],
    });
    mutateLibraryFolders
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
    expect(mutateLibraryFolders).toHaveBeenCalledTimes(2);
  });
});
