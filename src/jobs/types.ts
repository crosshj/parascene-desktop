/** Backend generation job (SQLite / Rust worker). */

export type JobStatus =
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled";

export type JobKind =
  | "ensure_project_groups"
  | "cleanup_project_groups"
  | "create_media"
  | "wait_creation"
  | "group_creations"
  | "delete_creation";

export type Job = {
  id: string;
  kind: JobKind | string;
  status: JobStatus | string;
  projectId?: string | null;
  label?: string | null;
  payloadJson: string;
  resultJson?: string | null;
  checkpointJson?: string | null;
  progressNote?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EnqueueJobRequest = {
  kind: JobKind | string;
  projectId?: string | null;
  label?: string | null;
  payload: Record<string, unknown>;
};

export type EnsureGroupsCheckpoint = {
  imagesGroupId?: string | null;
  videosGroupId?: string | null;
  pendingCreationId?: string | null;
  projectCreationIds?: string[];
  messages?: string[];
};

export type EnsureGroupsJobResult = {
  imagesGroupId: string | null;
  videosGroupId: string | null;
  projectCreationIds: string[];
  messages: string[];
};

export type CleanupGroupsJobResult = {
  deletedIds: string[];
  messages: string[];
};

export function isTerminalJobStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function parseJobJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
