/**
 * Service API contract types.
 *
 * FE collects values + AssetRefs, invokes, watches a handle, paints status.
 * See docs/PLAN-service-and-forms.md.
 */

/** Catalog creation id — FE currency. No localPath / remoteUrl / isLocal. */
export type AssetRef = { id: string };

/** Where a generated creation lands. Same object either way. */
export type CreationTarget = "assets" | "timeline";

export type ServiceId =
  | "parascene"
  | "blue"
  | "replicate"
  | "local"
  | "catalog"
  | "sync"
  | "publisher"
  | "auth";

export type PlacementPolicy = {
  lane: "parascene" | "blue_direct" | "replicate" | "local";
  inputs: "creation_required" | "local_ok" | "none";
  outputs: "creation_and_catalog" | "local_catalog_only" | "files_only";
  intermediates: "transport_only" | "durable_local";
};

/** Activity on a job handle — same machine as jobs.status. */
export type ActivityState =
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled";

export type ActivityCheckpoint =
  | "provision_inputs"
  | "extract_frame"
  | "upload_input"
  | "create"
  | "wait"
  | "ingest"
  | string;

export type ProvenanceInputRole =
  | "first"
  | "last"
  | "audio"
  | "video"
  | "ref";

export type ProvenanceRecord = {
  method: string;
  args: Record<string, unknown>;
  lane: PlacementPolicy["lane"];
  inputRefs: Array<{ role: ProvenanceInputRole; ref: AssetRef }>;
};

/**
 * Slot value before provision. Extract/upload is the adapter's job —
 * FE never says "upload because Parascene".
 */
export type MediaSourceIntent =
  | { from: "asset"; ref: AssetRef }
  | { from: "timeline"; clipId: string; atSec?: number }
  | { from: "none" };

export type FieldKind =
  | "text"
  | "textarea"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "slider"
  | "media";

export type MediaSlotKind =
  | "image"
  | "image_pair"
  | "audio"
  | "video"
  | "references"
  | "file";

/** Field descriptor from service_describe (ReplicateInputField + annotations). */
export type FieldSchema = {
  name: string;
  title?: string | null;
  description?: string | null;
  kind: FieldKind;
  required: boolean;
  defaultValue?: unknown;
  enumValues?: string[] | null;
  minimum?: number | null;
  maximum?: number | null;
  mediaSlot?: MediaSlotKind;
  hidden?: boolean;
  advanced?: boolean;
  persist?: boolean;
};

export type ServiceCapabilityStatus = "wired" | "coming_soon" | "unavailable";

export type ServiceCredentialGate = {
  required: boolean;
  configured: boolean;
  /** Typed error code when invoke would fail. */
  code?: "needs_credentials";
  message?: string | null;
};

export type ServiceDescribeRequest = {
  service: ServiceId | string;
  operation: string;
  context?: Record<string, unknown> | null;
};

export type ServiceDescribe = {
  service: string;
  operation: string;
  status: ServiceCapabilityStatus;
  label?: string | null;
  description?: string | null;
  fields: FieldSchema[];
  placement?: PlacementPolicy | null;
  credentials?: ServiceCredentialGate | null;
  /** Operation needs a clip/range as input context (not a different result type). */
  needsTimelineContext?: boolean;
  /** UX default when caller may choose. */
  defaultTarget?: CreationTarget | null;
  allowedTargets?: CreationTarget[] | null;
};

export type ServiceListEntry = {
  service: string;
  operation: string;
  status: ServiceCapabilityStatus;
  label?: string | null;
};

export type ServiceInvokeRequest = {
  service: ServiceId | string;
  operation: string;
  payload: Record<string, unknown>;
  target?: CreationTarget | null;
  projectId?: string | null;
  label?: string | null;
  clientRequestId?: string | null;
};

/**
 * Always returned from service_invoke.
 * job — durable work (generate, sync, render, …)
 * result — cheap sync reads (creds status, capabilities cache)
 */
export type ServiceHandle =
  | { mode: "job"; id: string }
  | { mode: "result"; data: unknown };

/** Job row shape shared with jobsClient (camelCase from Rust). */
export type ServiceRun = {
  id: string;
  kind: string;
  status: ActivityState | string;
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

export type ServiceCheckpoint = {
  name?: ActivityCheckpoint | null;
  messages?: string[];
  [key: string]: unknown;
};

export function assetRef(id: string): AssetRef {
  return { id: id.trim() };
}

export function isAssetRef(value: unknown): value is AssetRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.trim().length > 0;
}

export function isTerminalActivityState(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** Map handle status → Result | Form dual-view phase. */
export function dualPhaseFromActivity(
  status: string | null | undefined,
): "pre_gen" | "running" | "done" | "error" {
  if (!status || status === "queued") return "pre_gen";
  if (status === "done") return "done";
  if (status === "failed" || status === "cancelled") return "error";
  return "running";
}

export function parseJsonBlob<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function checkpointFromRun(run: ServiceRun): ServiceCheckpoint | null {
  return (
    parseJsonBlob<ServiceCheckpoint>(run.checkpointJson) ??
    parseJsonBlob<ServiceCheckpoint>(run.resultJson)
  );
}

export function progressMessagesFromRun(run: ServiceRun): string[] {
  const checkpoint = checkpointFromRun(run);
  if (checkpoint?.messages?.length) {
    return checkpoint.messages.filter((m): m is string => typeof m === "string");
  }
  if (run.progressNote) return [run.progressNote];
  return [];
}
