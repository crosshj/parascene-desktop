/** Catalog of project-level Looks (export-time GPU CRT presets + FFmpeg fallback). */

export const PROJECT_LOOK_IDS = ["tv", "afterglow", "broadcast"] as const;
export type ProjectLookId = (typeof PROJECT_LOOK_IDS)[number];

export type ProjectLookState = {
  enabled: boolean;
  /** Future UI overrides; omitted = engine defaults in Rust. */
  params?: Record<string, number>;
};

export type ProjectLooks = Partial<Record<ProjectLookId, ProjectLookState>>;

export const PROJECT_LOOK_OPTIONS: ReadonlyArray<{
  id: ProjectLookId;
  label: string;
  sublabel: string;
}> = [
  { id: "tv", label: "TV", sublabel: "export" },
  { id: "afterglow", label: "Afterglow", sublabel: "export" },
  { id: "broadcast", label: "Broadcast", sublabel: "export" },
];

export function isProjectLookId(value: unknown): value is ProjectLookId {
  return (
    typeof value === "string" &&
    (PROJECT_LOOK_IDS as readonly string[]).includes(value)
  );
}

/** Normalize persisted looks; unknown ids dropped; at most one enabled. */
export function normalizeProjectLooks(value: unknown): ProjectLooks {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: ProjectLooks = {};
  let enabledId: ProjectLookId | null = null;
  for (const id of PROJECT_LOOK_IDS) {
    const entry = raw[id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    let enabled = row.enabled === true;
    // Keep only the first enabled Look in catalog order.
    if (enabled && enabledId !== null) enabled = false;
    if (enabled) enabledId = id;
    const params = normalizeLookParams(row.params);
    out[id] = params ? { enabled, params } : { enabled };
  }
  return out;
}

function normalizeLookParams(
  value: unknown,
): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || !key.trim()) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) continue;
    out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Human labels for enabled looks, in catalog order. */
export function enabledLookLabels(looks: ProjectLooks | undefined): string[] {
  const normalized = normalizeProjectLooks(looks);
  return PROJECT_LOOK_OPTIONS.filter((opt) => normalized[opt.id]?.enabled).map(
    (opt) => opt.label,
  );
}

export function isLookEnabled(
  looks: ProjectLooks | undefined,
  id: ProjectLookId,
): boolean {
  return normalizeProjectLooks(looks)[id]?.enabled === true;
}

/** First enabled Look id in catalog order (matches Rust GPU preference). */
export function firstEnabledLookId(
  looks: ProjectLooks | undefined,
): ProjectLookId | null {
  const normalized = normalizeProjectLooks(looks);
  for (const id of PROJECT_LOOK_IDS) {
    if (normalized[id]?.enabled) return id;
  }
  return null;
}
