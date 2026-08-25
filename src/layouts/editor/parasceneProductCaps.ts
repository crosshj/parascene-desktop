/**
 * Hardcoded Parascene product server capabilities (servers 1 + 6).
 * Snapshot: docs/parascene-product-server-caps.json
 * Refresh: scripts/probe-parascene-servers.mts (or re-fetch GET /api/servers).
 *
 * Generate “Parascene” UI server (`parascene_blue`) routes to:
 * - **server 6** — Blue methods (`text2image`, `image2image`, video methods)
 * - **server 1** — Replicate / Replicate Pro / PixelLab stills (+ upload staging elsewhere)
 */

import productCaps from "../../../docs/parascene-product-server-caps.json";
import type { GenerateIntentId } from "./previewIntent";

export type ParasceneProductServerId = 1 | 6;

export type ParasceneMethodOption = {
  value: string;
  label: string;
  hint?: string;
};

export type ParasceneStillModelFamily =
  | "blue"
  | "replicate"
  | "replicate_pro"
  | "pixellab";

export type ParasceneStillModelOption = ParasceneMethodOption & {
  /** Stable picker id — `${serverId}:${method}:${value}` */
  id: string;
  serverId: ParasceneProductServerId;
  method: string;
  family: ParasceneStillModelFamily;
  supportsInputImages: boolean;
};

export type ParasceneMethodDef = {
  id?: string;
  name?: string;
  description?: string;
  staging_only?: boolean;
  credits?: number;
  supports_intents?: GenerateIntentId[];
  fields?: {
    model?: {
      options?: Array<{
        value?: string;
        label?: string;
        hint?: string;
      }>;
    };
    input_images?: unknown;
    [key: string]: unknown;
  };
};

export type ParasceneCapabilityMatrixRow = {
  method?: string;
  model?: string;
  family?: string;
  capabilities?: string[];
  nativeAudio?: boolean;
  flf?: boolean;
};

type ProductCapsFile = {
  _meta?: {
    server_ids?: string[];
  };
  servers?: Record<
    string,
    {
      id?: number;
      name?: string;
      methods?: Record<string, ParasceneMethodDef>;
      capability_matrix?: ParasceneCapabilityMatrixRow[];
    }
  >;
};

const CAPS = productCaps as ProductCapsFile;

/** Product lane servers (1 + 6) in caps snapshot order. */
export function productCapsServerIds(): ParasceneProductServerId[] {
  const fromMeta = CAPS._meta?.server_ids
    ?.map((id) => Number(id))
    .filter((id): id is ParasceneProductServerId => id === 1 || id === 6);
  if (fromMeta && fromMeta.length > 0) return fromMeta;
  return [1, 6];
}

function stillMethodFamily(
  serverId: ParasceneProductServerId,
  method: string,
): ParasceneStillModelFamily | null {
  if (serverId === 6) {
    if (method === "text2image" || method === "image2image") return "blue";
    return null;
  }
  if (serverId === 1) {
    return STILL_FAMILY[method as keyof typeof STILL_FAMILY] ?? null;
  }
  return null;
}

function stillMethodAppliesToIntent(
  method: string,
  intentId: "text_to_image" | "image_to_image",
): boolean {
  if (intentId === "text_to_image") {
    return (
      method === "text2image" ||
      method === "replicate" ||
      method === "replicatePro" ||
      method === "pixelLabImage"
    );
  }
  return (
    method === "image2image" ||
    method === "replicate" ||
    method === "replicatePro"
  );
}

function stillModelRoutesInCapsOrder(
  intentId: "text_to_image" | "image_to_image",
): Array<{
  serverId: ParasceneProductServerId;
  method: string;
  family: ParasceneStillModelFamily;
}> {
  const routes: Array<{
    serverId: ParasceneProductServerId;
    method: string;
    family: ParasceneStillModelFamily;
  }> = [];
  for (const serverId of productCapsServerIds()) {
    const methods = serverCaps(serverId)?.methods ?? {};
    for (const method of Object.keys(methods)) {
      if (!stillMethodAppliesToIntent(method, intentId)) continue;
      const family = stillMethodFamily(serverId, method);
      if (!family) continue;
      routes.push({ serverId, method, family });
    }
  }
  return routes;
}

/** Blue method ids on server 6 → Generate intents. */
const METHOD_TO_INTENT: Record<string, GenerateIntentId> = {
  text2image: "text_to_image",
  image2image: "image_to_image",
  text2video: "text_to_video",
  image2video: "image_to_video",
  audio2video: "image_audio_to_video",
  video2video: "video_to_video",
  reference2video: "reference_to_video",
};

const STILL_FAMILY: Record<
  "replicate" | "replicatePro" | "pixelLabImage",
  ParasceneStillModelFamily
> = {
  replicate: "replicate",
  replicatePro: "replicate_pro",
  pixelLabImage: "pixellab",
};

const STILL_FAMILY_NAME: Record<ParasceneStillModelFamily, string> = {
  blue: "Blue",
  replicate: "Replicate",
  replicate_pro: "Replicate Pro",
  pixellab: "PixelLab",
};

export function formatParasceneCredits(credits: number): string {
  const unit = credits === 1 ? "credit" : "credits";
  return `${credits} ${unit}`;
}

function methodCreditsFromCaps(
  serverId: ParasceneProductServerId,
  method: string,
): number | null {
  const raw = serverCaps(serverId)?.methods?.[method]?.credits;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function stillFamilyCredits(
  family: ParasceneStillModelFamily,
  intentId: "text_to_image" | "image_to_image",
): number | null {
  switch (family) {
    case "blue":
      return methodCreditsFromCaps(
        6,
        intentId === "text_to_image" ? "text2image" : "image2image",
      );
    case "replicate":
      return methodCreditsFromCaps(1, "replicate");
    case "replicate_pro":
      return methodCreditsFromCaps(1, "replicatePro");
    case "pixellab":
      return methodCreditsFromCaps(1, "pixelLabImage");
    default:
      return null;
  }
}

function stillFamilyLabel(
  family: ParasceneStillModelFamily,
  intentId: "text_to_image" | "image_to_image",
): string {
  const name = STILL_FAMILY_NAME[family];
  const credits = stillFamilyCredits(family, intentId);
  if (credits == null) return `${name} (credits)`;
  return `${name} (${formatParasceneCredits(credits)})`;
}

/** API method name for sdk.create on the Parascene Blue product path (server 6). */
export function parasceneMethodForIntent(
  intentId: GenerateIntentId,
): string | null {
  const server = serverCaps(6);
  if (!server?.methods) return null;
  for (const [method, mapped] of Object.entries(METHOD_TO_INTENT)) {
    if (mapped === intentId && server.methods[method]) return method;
  }
  return null;
}

/**
 * Default Parascene create API server_id for an intent.
 * Stills vary by selected model — use {@link parasceneResolveStillModel}.
 */
export function parasceneServerIdForIntent(
  intentId: GenerateIntentId,
): ParasceneProductServerId | null {
  if (intentId === "text_to_image" || intentId === "image_to_image") {
    return parasceneStillModelsForIntent(intentId).length > 0 ? 6 : null;
  }
  if (parasceneMethodForIntent(intentId)) return 6;
  return null;
}

export function serverCaps(serverId: ParasceneProductServerId | number) {
  return CAPS.servers?.[String(serverId)] ?? null;
}

function optionsFromMethod(
  def: ParasceneMethodDef | null | undefined,
): ParasceneMethodOption[] {
  const opts = def?.fields?.model?.options ?? [];
  return opts
    .map((o) => ({
      value: String(o.value ?? "").trim(),
      label: String(o.label ?? o.value ?? "").trim(),
      hint: typeof o.hint === "string" && o.hint.trim() ? o.hint.trim() : undefined,
    }))
    .filter((o) => o.value);
}

function modelSupportsInputImages(hint?: string): boolean {
  if (!hint) return false;
  const h = hint.toLowerCase();
  if (h.includes("no input image")) return false;
  return (
    h.includes("supports") &&
    (h.includes("input") || h.includes("image") || h.includes("multi-image"))
  );
}

export function parasceneStillModelId(
  serverId: ParasceneProductServerId,
  method: string,
  value: string,
): string {
  return `${serverId}:${method}:${value}`;
}

function stillModelsFromMethod(opts: {
  serverId: ParasceneProductServerId;
  method: string;
  family: ParasceneStillModelFamily;
  intentId: "text_to_image" | "image_to_image";
  def: ParasceneMethodDef | null | undefined;
}): ParasceneStillModelOption[] {
  const hasInputField = Boolean(opts.def?.fields?.input_images);
  return optionsFromMethod(opts.def)
    .map((opt) => {
      const hintSupportsInput = modelSupportsInputImages(opt.hint);
      if (opts.intentId === "image_to_image") {
        if (opts.method === "pixelLabImage") return null;
        if (opts.method === "replicate" || opts.method === "replicatePro") {
          if (!hasInputField || !hintSupportsInput) return null;
        }
      }
      return {
        ...opt,
        id: parasceneStillModelId(opts.serverId, opts.method, opt.value),
        serverId: opts.serverId,
        method: opts.method,
        family: opts.family,
        supportsInputImages:
          opts.intentId === "image_to_image"
            ? opts.method === "image2image" || hintSupportsInput
            : hintSupportsInput,
      } satisfies ParasceneStillModelOption;
    })
    .filter((m): m is ParasceneStillModelOption => m !== null);
}

/** All Parascene product still models for T2I / I2I (caps server + method order). */
export function parasceneStillModelsForIntent(
  intentId: "text_to_image" | "image_to_image",
): ParasceneStillModelOption[] {
  const out: ParasceneStillModelOption[] = [];
  for (const route of stillModelRoutesInCapsOrder(intentId)) {
    out.push(
      ...stillModelsFromMethod({
        serverId: route.serverId,
        method: route.method,
        family: route.family,
        intentId,
        def: serverCaps(route.serverId)?.methods?.[route.method],
      }),
    );
  }
  return out;
}

export function parasceneStillModelFamilies(
  intentId: "text_to_image" | "image_to_image",
): Array<{ family: ParasceneStillModelFamily; label: string; models: ParasceneStillModelOption[] }> {
  const grouped = new Map<ParasceneStillModelFamily, ParasceneStillModelOption[]>();
  const familyOrder: ParasceneStillModelFamily[] = [];

  for (const route of stillModelRoutesInCapsOrder(intentId)) {
    const models = stillModelsFromMethod({
      serverId: route.serverId,
      method: route.method,
      family: route.family,
      intentId,
      def: serverCaps(route.serverId)?.methods?.[route.method],
    });
    if (models.length === 0) continue;
    if (!grouped.has(route.family)) {
      familyOrder.push(route.family);
      grouped.set(route.family, []);
    }
    grouped.get(route.family)!.push(...models);
  }

  return familyOrder.map((family) => ({
    family,
    label: stillFamilyLabel(family, intentId),
    models: grouped.get(family) ?? [],
  }));
}

/** `<optgroup>`s for Generate still model selects (caps server + family order). */
export function parasceneStillModelEnumGroups(
  intentId: "text_to_image" | "image_to_image",
): Array<{ label: string; values: string[] }> {
  return parasceneStillModelFamilies(intentId).map((group) => ({
    label: group.label,
    values: group.models.map((m) => m.id),
  }));
}

export function parasceneResolveStillModel(
  intentId: "text_to_image" | "image_to_image",
  modelId: string,
): ParasceneStillModelOption | null {
  const id = modelId.trim();
  if (!id) return null;
  return (
    parasceneStillModelsForIntent(intentId).find(
      (m) => m.id === id || m.value === id,
    ) ?? null
  );
}

export function parasceneIntentIsWired(intentId: GenerateIntentId): boolean {
  if (intentId === "text_to_image" || intentId === "image_to_image") {
    return parasceneStillModelsForIntent(intentId).length > 0;
  }
  const method = parasceneMethodForIntent(intentId);
  if (!method) return false;
  const def = serverCaps(6)?.methods?.[method];
  if (!def || def.staging_only) return false;
  return true;
}

/** Blue still models on server 6 (`text2image` / `image2image`). */
export function parasceneBlueStillModels(
  method: "text2image" | "image2image" = "text2image",
): ParasceneMethodOption[] {
  return optionsFromMethod(serverCaps(6)?.methods?.[method]);
}

/** @deprecated Prefer parasceneStillModelsForIntent — name was from the server-1-only mistake. */
export function parasceneReplicateImageModels(): ParasceneMethodOption[] {
  const server1 = serverCaps(1);
  return [
    ...optionsFromMethod(server1?.methods?.replicate),
    ...optionsFromMethod(server1?.methods?.replicatePro),
    ...optionsFromMethod(server1?.methods?.pixelLabImage),
  ];
}

export type ParasceneVideoModelOption = {
  id: string;
  label: string;
  method: string;
  serverId: ParasceneProductServerId;
  flf: boolean;
  nativeAudio: boolean;
  hint?: string;
};

export function parasceneVideoModels(): ParasceneVideoModelOption[] {
  const out: ParasceneVideoModelOption[] = [];
  const seen = new Set<string>();

  const pushFromServer = (
    serverId: ParasceneProductServerId,
    methods: Record<string, ParasceneMethodDef> | undefined,
    matrix: ParasceneCapabilityMatrixRow[],
  ) => {
    for (const row of matrix) {
      const method = row.method?.trim();
      const model = row.model?.trim();
      if (!method || !model) continue;
      const key = `${serverId}:${method}:${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const opts = optionsFromMethod(methods?.[method]);
      const hit = opts.find((o) => o.value === model);
      out.push({
        id: model,
        label: hit?.label ?? model,
        method,
        serverId,
        flf: Boolean(row.flf),
        nativeAudio: Boolean(row.nativeAudio),
        hint: hit?.hint,
      });
    }

    if (matrix.length > 0) return;

    for (const [method, def] of Object.entries(methods ?? {})) {
      if (!METHOD_TO_INTENT[method] && method !== "replicateVideo") continue;
      if (method === "text2image" || method === "image2image") continue;
      for (const opt of optionsFromMethod(def)) {
        const key = `${serverId}:${method}:${opt.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: opt.value,
          label: opt.label,
          method,
          serverId,
          flf: method === "image2video",
          nativeAudio: method === "audio2video" || method === "text2video",
          hint: opt.hint,
        });
      }
    }
  };

  for (const serverId of productCapsServerIds()) {
    pushFromServer(
      serverId,
      serverCaps(serverId)?.methods,
      serverCaps(serverId)?.capability_matrix ?? [],
    );
  }

  return out;
}

export function parasceneVideoModelsForIntent(
  intentId: GenerateIntentId,
): ParasceneVideoModelOption[] {
  const method = parasceneMethodForIntent(intentId);
  if (!method) return [];
  return parasceneVideoModels().filter((m) => m.method === method);
}

export function parasceneVideoModelsForMethod(
  method: string,
): ParasceneVideoModelOption[] {
  return parasceneVideoModels().filter((m) => m.method === method);
}

/** Core Creation-path video models historically used on desktop. */
export function parasceneProductVideoModelIds(): Set<string> {
  const preferred = [
    "wan_t2v",
    "ltx_t2v",
    "wan_i2v",
    "ltx_i2v",
    "ltx_a2v",
  ];
  const fromCaps = new Set(parasceneVideoModels().map((m) => m.id));
  return new Set(preferred.filter((id) => fromCaps.has(id)));
}
