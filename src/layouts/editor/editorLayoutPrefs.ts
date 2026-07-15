export const EDITOR_LAYOUT_PREFS_KEY = "parascene.editorLayout.v1";

export const ASSETS_WIDTH_MIN = 280;
/** Absolute ceiling when workspace size is unknown (persistence / first paint). */
export const ASSETS_WIDTH_MAX = 2400;
export const ASSETS_WIDTH_DEFAULT = 320;
/** Preview must keep at least this much after expanding assets. */
export const PREVIEW_WIDTH_MIN = 160;

export const ASSISTANT_WIDTH_MIN = 320;
/** Absolute ceiling when workspace size is unknown (persistence / first paint). */
export const ASSISTANT_WIDTH_MAX = 2400;
export const ASSISTANT_WIDTH_DEFAULT = 360;
/** Collapsed assistant strip width reserved from the workspace. */
export const ASSISTANT_COLLAPSED_STRIP = 32;

export const TIMELINE_HEIGHT_MIN = 240;
export const TIMELINE_HEIGHT_DEFAULT = 280;
/** Timeline may claim at most this fraction of the workspace height. */
export const TIMELINE_HEIGHT_MAX_RATIO = 0.55;

export type EditorLayoutPrefs = {
  assetsWidth: number;
  assistantWidth: number;
  timelineHeight: number;
};

export const DEFAULT_EDITOR_LAYOUT_PREFS: EditorLayoutPrefs = {
  assetsWidth: ASSETS_WIDTH_DEFAULT,
  assistantWidth: ASSISTANT_WIDTH_DEFAULT,
  timelineHeight: TIMELINE_HEIGHT_DEFAULT,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function assetsWidthMax(opts?: {
  workspaceWidth?: number;
  reservedRight?: number;
}): number {
  const workspace = opts?.workspaceWidth;
  if (!(workspace && workspace > 0)) return ASSETS_WIDTH_MAX;
  const reserved = Math.max(0, opts?.reservedRight ?? 0);
  return Math.max(
    ASSETS_WIDTH_MIN,
    Math.min(ASSETS_WIDTH_MAX, workspace - PREVIEW_WIDTH_MIN - reserved),
  );
}

export function clampAssetsWidth(
  n: number,
  opts?: { workspaceWidth?: number; reservedRight?: number },
): number {
  return clamp(Math.round(n), ASSETS_WIDTH_MIN, assetsWidthMax(opts));
}

export function assistantWidthMax(opts?: {
  workspaceWidth?: number;
  reservedLeft?: number;
}): number {
  const workspace = opts?.workspaceWidth;
  if (!(workspace && workspace > 0)) return ASSISTANT_WIDTH_MAX;
  const reserved = Math.max(0, opts?.reservedLeft ?? 0);
  return Math.max(
    ASSISTANT_WIDTH_MIN,
    Math.min(ASSISTANT_WIDTH_MAX, workspace - PREVIEW_WIDTH_MIN - reserved),
  );
}

export function clampAssistantWidth(
  n: number,
  opts?: { workspaceWidth?: number; reservedLeft?: number },
): number {
  return clamp(Math.round(n), ASSISTANT_WIDTH_MIN, assistantWidthMax(opts));
}

export function clampTimelineHeight(
  n: number,
  workspaceHeight?: number,
): number {
  const max =
    workspaceHeight && workspaceHeight > 0
      ? Math.max(
          TIMELINE_HEIGHT_MIN,
          Math.floor(workspaceHeight * TIMELINE_HEIGHT_MAX_RATIO),
        )
      : Math.max(TIMELINE_HEIGHT_MIN, 520);
  return clamp(Math.round(n), TIMELINE_HEIGHT_MIN, max);
}

export function loadEditorLayoutPrefs(): EditorLayoutPrefs {
  try {
    const raw = localStorage.getItem(EDITOR_LAYOUT_PREFS_KEY);
    if (!raw) return { ...DEFAULT_EDITOR_LAYOUT_PREFS };
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { ...DEFAULT_EDITOR_LAYOUT_PREFS };

    return {
      assetsWidth: clampAssetsWidth(
        Number(parsed.assetsWidth) || ASSETS_WIDTH_DEFAULT,
      ),
      assistantWidth: clampAssistantWidth(
        Number(parsed.assistantWidth) || ASSISTANT_WIDTH_DEFAULT,
      ),
      timelineHeight: clampTimelineHeight(
        Number(parsed.timelineHeight) || TIMELINE_HEIGHT_DEFAULT,
      ),
    };
  } catch {
    return { ...DEFAULT_EDITOR_LAYOUT_PREFS };
  }
}

export function saveEditorLayoutPrefs(prefs: EditorLayoutPrefs): void {
  try {
    localStorage.setItem(EDITOR_LAYOUT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota / private mode
  }
}
