/**
 * Parascene catalog reads/writes via service_invoke (sync Result handles).
 */
import type { RemoteCreateImage } from "../sdk/parascene";
import { serviceInvoke } from "./serviceClient";

async function invokeResult(
  service: string,
  operation: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const handle = await serviceInvoke({ service, operation, payload });
  if (handle.mode !== "result") {
    throw new Error(`${service}.${operation} expected a sync result handle`);
  }
  if (handle.data == null) {
    throw new Error(`${service}.${operation} returned no data`);
  }
  return handle.data;
}

export async function getRemoteCreation(id: string): Promise<RemoteCreateImage> {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("getRemoteCreation requires id");
  }
  const data = await invokeResult("parascene", "get_creation", { id: trimmed });
  return data as RemoteCreateImage;
}

export async function uploadFitThumbnailToCloud(id: string): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("uploadFitThumbnailToCloud requires id");
  }
  await invokeResult("parascene", "upload_fit_thumbnail", { id: trimmed });
}

export async function groupAppendCreations(opts: {
  ids: Array<string | number>;
  partyName?: string;
  meta?: Record<string, unknown>;
}): Promise<RemoteCreateImage> {
  const ids = opts.ids.map((id) => String(id).trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("groupAppendCreations requires ids");
  }
  const data = await invokeResult("parascene", "group_append", {
    ids,
    partyName: opts.partyName,
    meta: opts.meta,
  });
  return data as RemoteCreateImage;
}

export type ParasceneCredits = {
  balance: number;
  canClaim: boolean;
  lastClaimDate: string | null;
};

export async function getParasceneCredits(): Promise<ParasceneCredits> {
  const data = (await invokeResult("parascene", "get_credits", {})) as Record<
    string,
    unknown
  >;
  return {
    balance: typeof data.balance === "number" ? data.balance : 0,
    canClaim: data.canClaim === true,
    lastClaimDate:
      typeof data.lastClaimDate === "string" ? data.lastClaimDate : null,
  };
}

export async function recordAudioClipViaService(opts: {
  path?: string;
  bytesBase64?: string;
  contentType?: string;
  title?: string;
  durationSec?: number;
  sourceType?: string;
}): Promise<{
  id: string;
  audioUrl: string | null;
  title: string;
  durationSec: number | null;
}> {
  const payload: Record<string, unknown> = {
    contentType: opts.contentType ?? "audio/wav",
    title: opts.title,
    durationSec: opts.durationSec,
    sourceType: opts.sourceType,
  };
  if (opts.path?.trim()) payload.path = opts.path.trim();
  else if (opts.bytesBase64) payload.bytesBase64 = opts.bytesBase64;
  else throw new Error("recordAudioClipViaService requires path or bytesBase64");

  const data = (await invokeResult(
    "parascene",
    "record_audio_clip",
    payload,
  )) as Record<string, unknown>;
  const id = typeof data.id === "string" ? data.id : String(data.id ?? "");
  if (!id) throw new Error("record_audio_clip returned no id");
  return {
    id,
    audioUrl:
      typeof data.audioUrl === "string" && data.audioUrl.trim()
        ? data.audioUrl.trim()
        : null,
    title: typeof data.title === "string" ? data.title : "",
    durationSec:
      typeof data.durationSec === "number" ? data.durationSec : null,
  };
}

export async function deleteAudioClipViaService(clipId: string): Promise<void> {
  const id = clipId.trim();
  if (!id) throw new Error("deleteAudioClipViaService requires clipId");
  await invokeResult("parascene", "delete_audio_clip", { id });
}

export async function uploadGenericImageViaService(opts: {
  path?: string;
  bytesBase64?: string;
  contentType?: string;
  filename?: string;
}): Promise<{ url: string; key?: string }> {
  const payload: Record<string, unknown> = {
    contentType: opts.contentType ?? "image/jpeg",
    filename: opts.filename ?? "lab-frame.jpg",
  };
  if (opts.path?.trim()) payload.path = opts.path.trim();
  else if (opts.bytesBase64) payload.bytesBase64 = opts.bytesBase64;
  else {
    throw new Error("uploadGenericImageViaService requires path or bytesBase64");
  }
  const data = (await invokeResult(
    "parascene",
    "upload_generic_image",
    payload,
  )) as Record<string, unknown>;
  const url = typeof data.url === "string" ? data.url.trim() : "";
  if (!url) throw new Error("upload_generic_image returned no url");
  return {
    url,
    key: typeof data.key === "string" ? data.key : undefined,
  };
}

export async function ungroupCreationsViaService(
  id: string,
): Promise<{ restoredCreationIds: string[] }> {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("ungroupCreationsViaService requires id");
  const data = (await invokeResult("parascene", "ungroup", {
    id: trimmed,
  })) as Record<string, unknown>;
  const restored = Array.isArray(data.restoredCreationIds)
    ? data.restoredCreationIds
        .map((value) => String(value).trim())
        .filter(Boolean)
    : [];
  return { restoredCreationIds: restored };
}

export async function deleteCreationViaService(id: string): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("deleteCreationViaService requires id");
  await invokeResult("parascene", "delete_creation_sync", { id: trimmed });
}
