import { describe, expect, it } from "vitest";
import type { PendingFolderOp } from "../library/folderClient";
import {
  assertProjectIdOnMarkerClear,
  rewriteOwnedMarkerClearsToDeleteCreate,
} from "./folderSync";
import {
  buildFolderSyncFailureTrace,
  formatPendingOpsHeadline,
  summarizeFolderOperation,
  withPendingOpsContext,
} from "./folderSyncDiagnostics";

describe("folderSyncDiagnostics", () => {
  it("flags empty-meta updates as project-marker clears", () => {
    const trace = summarizeFolderOperation({
      op: "update",
      id: "folder-1",
      title: "Untitled project",
      meta: {},
    });
    expect(trace.clearsProjectMeta).toBe(true);
    expect(trace.title).toBe("Untitled project");
  });

  it("formats a Sync headline for mixed pending ops", () => {
    const pending: PendingFolderOp[] = [
      {
        seq: 1,
        createdAt: "t",
        op: { op: "update", id: "a", title: "A", meta: {} },
      },
      {
        seq: 2,
        createdAt: "t",
        op: { op: "update", id: "b", title: "B", meta: {} },
      },
      {
        seq: 3,
        createdAt: "t",
        op: { op: "move", folder_id: "c", creation_ids: [1] },
      },
    ];
    expect(formatPendingOpsHeadline(pending)).toBe(
      "3 pending: move×1, update×2 (meta clear×2)",
    );
  });

  it("attaches pending context and known hint for locked project folder", () => {
    const pending: PendingFolderOp[] = [
      {
        seq: 142,
        createdAt: "t",
        op: {
          op: "update",
          id: "b47f18fc-dcab-470b-ab00-beff1d26fcef",
          title: "Untitled project",
          meta: {},
        },
      },
    ];
    const message = withPendingOpsContext(
      "project folder is locked on this client",
      pending,
    );
    expect(message).toContain("1 pending: update×1 (meta clear×1)");
    const trace = buildFolderSyncFailureTrace({
      phase: "mutate",
      message,
      revision: 12,
      pending,
      uploadBatch: [pending[0]!.op],
    });
    expect(trace.hint).toMatch(/immutable|project-marked|meta\.parascene_desktop/i);
    expect(trace.pending[0]?.clearsProjectMeta).toBe(true);
  });
});

describe("ownership-asserted marker clears", () => {
  it("keeps ownership-asserted empty-meta clears", () => {
    const fixed = assertProjectIdOnMarkerClear({
      op: "update",
      id: "folder-1",
      title: "Untitled project",
      meta: {},
      project_id: "project-1",
    });
    expect(fixed).toEqual({
      op: "update",
      id: "folder-1",
      title: "Untitled project",
      meta: {},
      project_id: "project-1",
    });
  });

  it("does not invent project_id from cloud for foreign clears", () => {
    const fixed = assertProjectIdOnMarkerClear({
      op: "update",
      id: "folder-1",
      title: "Untitled project",
      meta: {},
    });
    expect(fixed).toEqual({
      op: "update",
      id: "folder-1",
      title: "Untitled project",
      meta: {},
    });
  });

  it("preserves already-asserted project_id on marker clears", () => {
    const fixed = assertProjectIdOnMarkerClear({
      op: "update",
      id: "folder-1",
      title: "Keep",
      meta: {},
      project_id: "already",
    });
    expect(fixed.op).toBe("update");
    if (fixed.op === "update") {
      expect(fixed.project_id).toBe("already");
      expect(fixed.meta).toEqual({});
    }
  });

  it("does not treat title-only updates as marker clears", () => {
    const fixed = assertProjectIdOnMarkerClear({
      op: "update",
      id: "folder-1",
      title: "Renamed",
    });
    expect(fixed).toEqual({
      op: "update",
      id: "folder-1",
      title: "Renamed",
    });
  });

  it("expands owned meta clears to delete+create and keeps Text Meme title", () => {
    const pending: PendingFolderOp[] = [
      {
        seq: 152,
        createdAt: "t",
        op: {
          op: "update",
          id: "folder-1",
          title: "Untitled project",
          meta: {},
          project_id: "project-1",
        },
      },
      {
        seq: 153,
        createdAt: "t",
        op: { op: "update", id: "folder-1", title: "Text Meme" },
      },
    ];
    const expanded = rewriteOwnedMarkerClearsToDeleteCreate(
      pending,
      new Map([
        [
          "folder-1",
          { title: "Untitled project", description: "", creationIds: [101, 102] },
        ],
      ]),
    );
    expect(expanded).toEqual([
      { op: "delete", id: "folder-1", project_id: "project-1" },
      {
        op: "create",
        id: "folder-1",
        title: "Text Meme",
        description: "",
        meta: {},
        creation_ids: [101, 102],
      },
    ]);
  });
});
