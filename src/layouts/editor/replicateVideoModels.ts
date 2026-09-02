/**
 * Load enabled Replicate models suitable for editor timeline video fill.
 */

import {
  replicateModelGet,
  replicateModelsListEnabled,
  type ReplicateInputField,
  type ReplicateModelDetail,
} from "../../replicate/replicateClient";
import {
  modelIncompatibilityReason,
  replicateVideoCapability,
  supportsContinuity,
  type ReplicateVideoContinuity,
} from "./replicateRunConstraints";

export type ReplicateVideoModelOption = {
  id: string;
  owner: string;
  name: string;
  label: string;
  description: string;
  inputs: ReplicateInputField[];
  startOnly: boolean;
  startEnd: boolean;
  motionControl: boolean;
};

const DEFAULT_PREFERENCE = [
  "minimax/h3",
  "bytedance/seedance-2.0-fast",
  "vidu/q3-turbo",
  "kwaivgi/kling-v2.5-turbo-pro",
  "kwaivgi/kling-v3-video",
  "google/veo-3.1-fast",
  "google/veo-3.1",
  "bytedance/seedance-2.0",
  "kwaivgi/kling-v3-motion-control",
] as const;

function parseOwnerName(id: string): { owner: string; name: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  return { owner: id.slice(0, slash), name: id.slice(slash + 1) };
}

export function modelSupportsAnyVideoFill(
  inputs: readonly ReplicateInputField[],
): boolean {
  const cap = replicateVideoCapability(inputs);
  return cap.startOnly || cap.startEnd || cap.motionControl;
}

/** Fetch enabled models that can do at least one timeline video continuity mode. */
export async function loadReplicateVideoFillModels(): Promise<
  ReplicateVideoModelOption[]
> {
  const enabled = await replicateModelsListEnabled();
  const options: ReplicateVideoModelOption[] = [];
  for (const id of enabled) {
    const parsed = parseOwnerName(id);
    if (!parsed) continue;
    let detail: ReplicateModelDetail | null;
    try {
      detail = await replicateModelGet(parsed.owner, parsed.name);
    } catch {
      continue;
    }
    if (!detail?.schemaCached || !detail.inputs?.length) continue;
    if (!modelSupportsAnyVideoFill(detail.inputs)) continue;
    const cap = replicateVideoCapability(detail.inputs);
    options.push({
      id,
      owner: parsed.owner,
      name: parsed.name,
      label: id,
      description: (detail.description ?? "").trim(),
      inputs: detail.inputs,
      startOnly: cap.startOnly,
      startEnd: cap.startEnd,
      motionControl: cap.motionControl,
    });
  }
  options.sort((a, b) => {
    const ai = DEFAULT_PREFERENCE.indexOf(
      a.id as (typeof DEFAULT_PREFERENCE)[number],
    );
    const bi = DEFAULT_PREFERENCE.indexOf(
      b.id as (typeof DEFAULT_PREFERENCE)[number],
    );
    const ap = ai === -1 ? 999 : ai;
    const bp = bi === -1 ? 999 : bi;
    if (ap !== bp) return ap - bp;
    return a.id.localeCompare(b.id);
  });
  return options;
}

export type PickReplicateModelOpts = {
  models: readonly ReplicateVideoModelOption[];
  continuity: ReplicateVideoContinuity;
  durationSec: number;
  aspectRatio: string;
  hasImageInput: boolean;
  /** Prefer keeping this id when still compatible. */
  preferredId?: string | null;
};

export function pickCompatibleReplicateModel(
  opts: PickReplicateModelOpts,
): ReplicateVideoModelOption | null {
  const compatible = opts.models.filter((m) => {
    if (!supportsContinuity(m, opts.continuity)) return false;
    return (
      modelIncompatibilityReason(
        m.inputs,
        opts.continuity,
        opts.durationSec,
        opts.aspectRatio,
        opts.hasImageInput,
      ) === null
    );
  });
  if (compatible.length === 0) return null;
  if (opts.preferredId) {
    const preferred = compatible.find((m) => m.id === opts.preferredId);
    if (preferred) return preferred;
  }
  return compatible[0] ?? null;
}

export function replicateModelOptionDisabledReason(
  model: ReplicateVideoModelOption,
  continuity: ReplicateVideoContinuity,
  durationSec: number,
  aspectRatio: string,
  hasImageInput: boolean,
): string | null {
  return modelIncompatibilityReason(
    model.inputs,
    continuity,
    durationSec,
    aspectRatio,
    hasImageInput,
  );
}
