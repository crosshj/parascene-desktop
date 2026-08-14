/**
 * Still workstream — plate compose session with linear bake/edit history.
 */

export type StillWorkstreamKind = "plate";

export type StillWorkstreamNodeStatus =
  | "candidate"
  | "selected"
  | "discarded";

export type PlateRecipe = {
  layout: "side_by_side";
  /** height_fill = fill top→bottom keep aspect, leftover width = gap. */
  placement: "height_fill" | "equal_columns";
  aspectRatio: string;
  resolution: number;
  /** Used for equal_columns slots. */
  framing: "fit" | "fill" | "stretch";
  gapMode: "auto" | "fixed";
  /** Used when gapMode is fixed. */
  gapPx: number;
  marginPx: number;
};

export type StillWorkstreamNode = {
  id: string;
  /** Null after discard deletes the local file. */
  creationId: string | null;
  /** Stable backing file for preview/edit, independent of Library UI sync. */
  localPath?: string;
  parentNodeId: string | null;
  status: StillWorkstreamNodeStatus;
  /**
   * When false (default), the node’s creation stays inside the composition
   * sandbox and does not appear as its own Assets item.
   */
  showOutside: boolean;
  prompt?: string;
  model?: string;
  settings?: Record<string, unknown>;
  createdAt: string;
};

export type StillWorkstream = {
  id: string;
  title: string;
  kind: StillWorkstreamKind;
  recipe: PlateRecipe;
  memberIds: string[];
  nodes: StillWorkstreamNode[];
  selectedNodeId: string | null;
  updatedAt: string;
};

function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createComposition(opts: {
  memberIds: string[];
  recipe: PlateRecipe;
  title?: string;
}): StillWorkstream {
  const now = new Date().toISOString();
  return {
    id: newId("sw"),
    title: opts.title?.trim() || "Composition",
    kind: "plate",
    recipe: opts.recipe,
    memberIds: [...opts.memberIds],
    nodes: [],
    selectedNodeId: null,
    updatedAt: now,
  };
}

export function createPlateWorkstream(opts: {
  memberIds: string[];
  recipe: PlateRecipe;
  firstCreationId: string;
  title?: string;
  showOutside?: boolean;
}): StillWorkstream {
  const now = new Date().toISOString();
  const nodeId = newId("swn");
  return {
    id: newId("sw"),
    title: opts.title?.trim() || "Composition",
    kind: "plate",
    recipe: opts.recipe,
    memberIds: [...opts.memberIds],
    nodes: [
      {
        id: nodeId,
        creationId: opts.firstCreationId,
        parentNodeId: null,
        status: "selected",
        showOutside: opts.showOutside === true,
        createdAt: now,
      },
    ],
    selectedNodeId: nodeId,
    updatedAt: now,
  };
}

/** Append a plate bake or AI-edit node; stays inside until promoted. */
export function appendWorkstreamEditNode(
  stream: StillWorkstream,
  opts: {
    creationId: string | null;
    localPath?: string;
    parentNodeId: string | null;
    prompt?: string;
    model?: string;
    settings?: Record<string, unknown>;
    select?: boolean;
    showOutside?: boolean;
  },
): StillWorkstream {
  const now = new Date().toISOString();
  const nodeId = newId("swn");
  const select = opts.select !== false;
  const nodes = stream.nodes.map((node) =>
    select && node.status === "selected"
      ? { ...node, status: "candidate" as const }
      : node,
  );
  nodes.push({
    id: nodeId,
    creationId: opts.creationId,
    localPath: opts.localPath?.trim() || undefined,
    parentNodeId: opts.parentNodeId,
    status: select ? "selected" : "candidate",
    showOutside: opts.showOutside === true,
    prompt: opts.prompt,
    model: opts.model,
    settings: opts.settings,
    createdAt: now,
  });
  return {
    ...stream,
    nodes,
    selectedNodeId: select ? nodeId : stream.selectedNodeId,
    updatedAt: now,
  };
}

/** Mark a node visible as its own Assets item (promote out of the sandbox). */
export function promoteWorkstreamNode(
  stream: StillWorkstream,
  nodeId: string,
): StillWorkstream {
  if (!stream.nodes.some((n) => n.id === nodeId && n.status !== "discarded")) {
    return stream;
  }
  return {
    ...stream,
    nodes: stream.nodes.map((node) =>
      node.id === nodeId ? { ...node, showOutside: true } : node,
    ),
    updatedAt: new Date().toISOString(),
  };
}

/** Creation ids that belong to compositions and must stay off the Assets root. */
export function compositionInternalCreationIds(
  streams: readonly StillWorkstream[],
): Set<string> {
  const hidden = new Set<string>();
  for (const stream of streams) {
    for (const node of stream.nodes) {
      if (node.status === "discarded") continue;
      if (node.showOutside) continue;
      if (node.creationId) hidden.add(node.creationId);
    }
  }
  return hidden;
}

/** Composition source images that are referenced but not in the project folder. */
export function compositionOutsideMemberIds(
  stream: Pick<StillWorkstream, "memberIds">,
  outsideIds: ReadonlySet<string>,
): string[] {
  if (outsideIds.size === 0) return [];
  return stream.memberIds.filter((id) => {
    const trimmed = id.trim();
    return Boolean(trimmed) && outsideIds.has(trimmed);
  });
}

export function selectWorkstreamNode(
  stream: StillWorkstream,
  nodeId: string,
): StillWorkstream {
  if (!stream.nodes.some((n) => n.id === nodeId && n.status !== "discarded")) {
    return stream;
  }
  const nodes = stream.nodes.map((node) => {
    if (node.id === nodeId) return { ...node, status: "selected" as const };
    if (node.status === "selected") {
      return { ...node, status: "candidate" as const };
    }
    return node;
  });
  return {
    ...stream,
    nodes,
    selectedNodeId: nodeId,
    updatedAt: new Date().toISOString(),
  };
}

/** Select the live composer/plate recipe as the next edit base. */
export function selectWorkstreamPlate(stream: StillWorkstream): StillWorkstream {
  return {
    ...stream,
    nodes: stream.nodes.map((node) =>
      node.status === "selected"
        ? { ...node, status: "candidate" as const }
        : node,
    ),
    selectedNodeId: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Discard one internal run and select a sensible remaining base if needed. */
export function discardWorkstreamNode(
  stream: StillWorkstream,
  nodeId: string,
): { stream: StillWorkstream; creationIdToDelete: string | null } {
  const target = stream.nodes.find(
    (node) => node.id === nodeId && node.status !== "discarded",
  );
  if (!target) {
    return { stream, creationIdToDelete: null };
  }

  const remaining = stream.nodes.filter(
    (node) => node.id !== nodeId && node.status !== "discarded" && node.creationId,
  );
  const fallback =
    remaining.find((node) => node.id === target.parentNodeId) ??
    remaining[remaining.length - 1] ??
    null;
  const selectedNodeId =
    stream.selectedNodeId === nodeId ? fallback?.id ?? null : stream.selectedNodeId;
  const nodes = stream.nodes.map((node) => {
    if (node.id === nodeId) {
      return {
        ...node,
        creationId: null,
        localPath: undefined,
        status: "discarded" as const,
      };
    }
    if (stream.selectedNodeId === nodeId && node.id === selectedNodeId) {
      return { ...node, status: "selected" as const };
    }
    return node;
  });
  return {
    stream: {
      ...stream,
      nodes,
      selectedNodeId,
      updatedAt: new Date().toISOString(),
    },
    creationIdToDelete: target.creationId,
  };
}

/**
 * Mark non-selected candidates discarded and return their creation ids
 * (for deleteLocal). Selected + discarded nodes are left alone; members
 * are never included.
 */
export function discardInterimWorkstreamNodes(stream: StillWorkstream): {
  stream: StillWorkstream;
  creationIdsToDelete: string[];
} {
  const selectedId = stream.selectedNodeId;
  const creationIdsToDelete: string[] = [];
  const nodes = stream.nodes.map((node) => {
    if (node.id === selectedId) return node;
    if (node.status === "discarded") return node;
    if (node.creationId) creationIdsToDelete.push(node.creationId);
    return {
      ...node,
      creationId: null,
      localPath: undefined,
      status: "discarded" as const,
    };
  });
  return {
    stream: {
      ...stream,
      nodes,
      updatedAt: new Date().toISOString(),
    },
    creationIdsToDelete,
  };
}

export function normalizePlateRecipe(value: unknown): PlateRecipe | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const aspectRatio =
    typeof row.aspectRatio === "string" && row.aspectRatio.trim()
      ? row.aspectRatio.trim()
      : "1:1";
  const framing =
    row.framing === "fill" || row.framing === "stretch" || row.framing === "fit"
      ? row.framing
      : "fit";
  const placement =
    row.placement === "equal_columns" ? "equal_columns" : "height_fill";
  const gapMode = row.gapMode === "fixed" ? "fixed" : "auto";
  const resolution = Number(row.resolution);
  const gapPx = Number(row.gapPx);
  const marginPx = Number(row.marginPx);
  return {
    layout: "side_by_side",
    placement,
    aspectRatio,
    resolution:
      Number.isFinite(resolution) && resolution >= 256 ? Math.round(resolution) : 2048,
    framing,
    gapMode,
    gapPx: Number.isFinite(gapPx) && gapPx >= 0 ? Math.round(gapPx) : 64,
    marginPx: Number.isFinite(marginPx) && marginPx >= 0 ? Math.round(marginPx) : 0,
  };
}

export function defaultPlateRecipe(): PlateRecipe {
  return {
    layout: "side_by_side",
    placement: "height_fill",
    aspectRatio: "1:1",
    resolution: 2048,
    framing: "fit",
    gapMode: "auto",
    gapPx: 64,
    marginPx: 0,
  };
}

export function normalizeStillWorkstreamNode(
  value: unknown,
): StillWorkstreamNode | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  const status =
    row.status === "selected" ||
    row.status === "discarded" ||
    row.status === "candidate"
      ? row.status
      : "candidate";
  const creationId =
    typeof row.creationId === "string" && row.creationId.trim()
      ? row.creationId.trim()
      : null;
  const localPath =
    typeof row.localPath === "string" && row.localPath.trim()
      ? row.localPath.trim()
      : undefined;
  const parentNodeId =
    typeof row.parentNodeId === "string" && row.parentNodeId.trim()
      ? row.parentNodeId.trim()
      : null;
  const createdAt =
    typeof row.createdAt === "string" && row.createdAt.trim()
      ? row.createdAt
      : new Date().toISOString();
  return {
    id: row.id.trim(),
    creationId,
    localPath,
    parentNodeId,
    status,
    showOutside: row.showOutside === true,
    prompt:
      typeof row.prompt === "string" && row.prompt.trim()
        ? row.prompt.trim()
        : undefined,
    model:
      typeof row.model === "string" && row.model.trim()
        ? row.model.trim()
        : undefined,
    settings:
      row.settings && typeof row.settings === "object"
        ? (row.settings as Record<string, unknown>)
        : undefined,
    createdAt,
  };
}

export function normalizeStillWorkstream(
  value: unknown,
): StillWorkstream | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  if (row.kind !== "plate") return null;
  const recipe = normalizePlateRecipe(row.recipe);
  if (!recipe) return null;
  const memberIds = Array.isArray(row.memberIds)
    ? row.memberIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
    : [];
  const nodes = Array.isArray(row.nodes)
    ? row.nodes
        .map(normalizeStillWorkstreamNode)
        .filter((n): n is StillWorkstreamNode => Boolean(n))
    : [];
  const selectedNodeId =
    typeof row.selectedNodeId === "string" && row.selectedNodeId.trim()
      ? row.selectedNodeId.trim()
      : nodes.find((n) => n.status === "selected")?.id ?? null;
  return {
    id: row.id.trim(),
    title:
      typeof row.title === "string" && row.title.trim()
        ? row.title.trim()
        : "Composition",
    kind: "plate",
    recipe,
    memberIds,
    nodes,
    selectedNodeId,
    updatedAt:
      typeof row.updatedAt === "string" && row.updatedAt.trim()
        ? row.updatedAt
        : new Date().toISOString(),
  };
}

export function normalizeStillWorkstreams(value: unknown): StillWorkstream[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeStillWorkstream)
    .filter((s): s is StillWorkstream => Boolean(s));
}
