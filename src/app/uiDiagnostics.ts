import { abortEditorGestures, releasePointerCaptureSafe } from "../layouts/editor/gestureCleanup";
import { getActiveStagedClipDrag } from "../layouts/editor/stagedClip";

export type PointerCaptureRecord = {
  tag: string;
  pointerId: number;
  since: string;
  hasCapture: boolean;
};

export type UiDiagnosticsReport = {
  generatedAt: string;
  window: {
    hasFocus: boolean;
    visibility: DocumentVisibilityState;
    width: number;
    height: number;
  };
  focus: {
    activeElement: string | null;
  };
  bodyClasses: string[];
  editorWorkspaceClasses: string[];
  activePointerCaptures: PointerCaptureRecord[];
  gestureProviders: Record<string, Record<string, unknown>>;
  stagedClipDrag: { active: boolean; kind: string | null };
  openModals: string[];
  centerHitTarget: string | null;
  centerHitStack: string[];
  viewportOverlays: string[];
  notes: string[];
};

type GestureStatusProvider = () => Record<string, unknown>;
const gestureStatusProviders = new Map<string, GestureStatusProvider>();

type TrackedCapture = {
  element: Element;
  pointerId: number;
  tag: string;
  since: string;
};

const trackedCaptures: TrackedCapture[] = [];
let pointerCaptureSpyInstalled = false;

function describeElement(el: Element | null | undefined): string | null {
  if (!el || el === document.documentElement) return null;
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const className =
    "className" in el && typeof el.className === "string" && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 4).join(".")}`
      : "";
  const role =
    el instanceof HTMLElement && el.getAttribute("role")
      ? `[role=${el.getAttribute("role")}]`
      : "";
  return `${tag}${id}${className}${role}`;
}

function removeTrackedCapture(element: Element, pointerId: number): void {
  for (let i = trackedCaptures.length - 1; i >= 0; i -= 1) {
    const row = trackedCaptures[i];
    if (row.element === element && row.pointerId === pointerId) {
      trackedCaptures.splice(i, 1);
    }
  }
}

/** Monkey-patch pointer capture so diagnostics can see stuck captures. */
export function installPointerCaptureSpy(): void {
  if (pointerCaptureSpyInstalled || typeof Element === "undefined") return;
  pointerCaptureSpyInstalled = true;

  const proto = Element.prototype;
  const originalSet = proto.setPointerCapture;
  const originalRelease = proto.releasePointerCapture;

  proto.setPointerCapture = function setPointerCapturePatched(
    this: Element,
    pointerId: number,
  ) {
    removeTrackedCapture(this, pointerId);
    trackedCaptures.push({
      element: this,
      pointerId,
      tag: describeElement(this) ?? this.tagName.toLowerCase(),
      since: new Date().toISOString(),
    });
    return originalSet.call(this, pointerId);
  };

  proto.releasePointerCapture = function releasePointerCapturePatched(
    this: Element,
    pointerId: number,
  ) {
    removeTrackedCapture(this, pointerId);
    return originalRelease.call(this, pointerId);
  };
}

export function registerGestureStatusProvider(
  id: string,
  provider: GestureStatusProvider,
): () => void {
  gestureStatusProviders.set(id, provider);
  return () => {
    gestureStatusProviders.delete(id);
  };
}

function collectGestureProviders(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, provider] of gestureStatusProviders) {
    try {
      out[id] = provider();
    } catch (error) {
      out[id] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return out;
}

function collectOpenModals(): string[] {
  return Array.from(document.querySelectorAll('[aria-modal="true"]'))
    .map((el) => describeElement(el))
    .filter((value): value is string => Boolean(value));
}

function collectViewportOverlays(): string[] {
  const minW = window.innerWidth * 0.85;
  const minH = window.innerHeight * 0.85;
  const matches: string[] = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!(el instanceof HTMLElement)) continue;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (style.pointerEvents === "none") continue;
    if (style.position !== "fixed" && style.position !== "absolute") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < minW || rect.height < minH) continue;
    const label = describeElement(el);
    if (label) matches.push(label);
  }
  return matches.slice(0, 12);
}

function collectCenterHitStack(): { target: string | null; stack: string[] } {
  if (typeof document.elementFromPoint !== "function") {
    return { target: null, stack: [] };
  }
  const x = Math.round(window.innerWidth / 2);
  const y = Math.round(window.innerHeight / 2);
  const stack: string[] = [];
  let node = document.elementFromPoint(x, y);
  while (node && node !== document.documentElement) {
    const label = describeElement(node);
    if (label) stack.push(label);
    node = node.parentElement;
  }
  return { target: stack[0] ?? null, stack };
}

function collectActivePointerCaptures(): PointerCaptureRecord[] {
  const rows: PointerCaptureRecord[] = [];
  for (const row of trackedCaptures) {
    let hasCapture = false;
    try {
      hasCapture = row.element.hasPointerCapture(row.pointerId);
    } catch {
      hasCapture = false;
    }
    rows.push({
      tag: row.tag,
      pointerId: row.pointerId,
      since: row.since,
      hasCapture,
    });
  }
  return rows;
}

function buildNotes(report: Omit<UiDiagnosticsReport, "notes">): string[] {
  const notes: string[] = [];
  const liveCaptures = report.activePointerCaptures.filter((row) => row.hasCapture);

  if (liveCaptures.length > 0) {
    notes.push(
      `Pointer capture is active on ${liveCaptures.length} element(s). This steals all mouse clicks until released — use Unlock UI.`,
    );
    for (const row of liveCaptures) {
      notes.push(`  • ${row.tag} (pointer ${row.pointerId}, since ${row.since})`);
    }
  }

  const dragClasses = report.bodyClasses.filter((className) =>
    className.startsWith("is-"),
  );
  if (dragClasses.length > 0) {
    notes.push(
      `Body drag state still set: ${dragClasses.join(", ")}. A drag may not have ended cleanly.`,
    );
  }

  if (report.editorWorkspaceClasses.length > 0) {
    notes.push(
      `Editor panel resize in progress (${report.editorWorkspaceClasses.join(", ")}). Splitter drags can block interaction until cleared.`,
    );
  }

  if (report.stagedClipDrag.active) {
    notes.push(
      `Staging clip drag is active${report.stagedClipDrag.kind ? ` (${report.stagedClipDrag.kind})` : ""}.`,
    );
  }

  if (report.openModals.length > 0) {
    notes.push(
      `Modal dialog open: ${report.openModals.join(", ")}. Backdrop may block clicks until dismissed.`,
    );
  }

  if (report.viewportOverlays.length > 0) {
    notes.push(
      `Large fixed/absolute layers cover the viewport: ${report.viewportOverlays.join(", ")}.`,
    );
  }

  const providerEntries = Object.entries(report.gestureProviders);
  for (const [id, snapshot] of providerEntries) {
    const active = Object.entries(snapshot).some(
      ([key, value]) =>
        key !== "error" &&
        value != null &&
        value !== false &&
        value !== "" &&
        value !== 0,
    );
    if (active) {
      notes.push(`Gesture provider “${id}”: ${JSON.stringify(snapshot)}`);
    }
  }

  if (notes.length === 0) {
    notes.push(
      "No obvious stuck pointer capture or drag state. If the UI is still frozen, copy this report and note what you were doing last.",
    );
  }

  return notes;
}

export function collectUiDiagnostics(): UiDiagnosticsReport {
  const workspace = document.querySelector(".editor-workspace");
  const workspaceClasses = workspace
    ? Array.from(workspace.classList).filter((className) =>
        className.startsWith("is-resizing-"),
      )
    : [];
  const staged = getActiveStagedClipDrag();
  const center = collectCenterHitStack();

  const partial = {
    generatedAt: new Date().toISOString(),
    window: {
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    focus: {
      activeElement: describeElement(document.activeElement),
    },
    bodyClasses: Array.from(document.body.classList),
    editorWorkspaceClasses: workspaceClasses,
    activePointerCaptures: collectActivePointerCaptures(),
    gestureProviders: collectGestureProviders(),
    stagedClipDrag: {
      active: staged != null,
      kind: staged?.kind ?? null,
    },
    openModals: collectOpenModals(),
    centerHitTarget: center.target,
    centerHitStack: center.stack,
    viewportOverlays: collectViewportOverlays(),
  };

  return {
    ...partial,
    notes: buildNotes(partial),
  };
}

export function formatUiDiagnosticsReport(report: UiDiagnosticsReport): string {
  const lines = [
    `Parascene UI diagnostics — ${report.generatedAt}`,
    "",
    "Summary",
    ...report.notes.map((note) => (note.startsWith("  •") ? note : `- ${note}`)),
    "",
    "Window",
    `- focus: ${report.window.hasFocus}`,
    `- visibility: ${report.window.visibility}`,
    `- size: ${report.window.width}×${report.window.height}`,
    "",
    "Focus",
    `- activeElement: ${report.focus.activeElement ?? "(none)"}`,
    "",
    "Body classes",
    report.bodyClasses.length > 0
      ? report.bodyClasses.map((className) => `  ${className}`).join("\n")
      : "  (none)",
    "",
    "Editor workspace",
    report.editorWorkspaceClasses.length > 0
      ? report.editorWorkspaceClasses.map((className) => `  ${className}`).join("\n")
      : "  (not resizing)",
    "",
    "Pointer capture",
    report.activePointerCaptures.length > 0
      ? report.activePointerCaptures
          .map(
            (row) =>
              `  ${row.hasCapture ? "ACTIVE" : "stale"} ${row.tag} pointer=${row.pointerId} since=${row.since}`,
          )
          .join("\n")
      : "  (none tracked)",
    "",
    "Center click target",
    report.centerHitTarget ?? "(none)",
    "",
    "Center hit stack",
    report.centerHitStack.length > 0
      ? report.centerHitStack.map((row) => `  ${row}`).join("\n")
      : "  (empty)",
    "",
    "Open modals",
    report.openModals.length > 0
      ? report.openModals.map((row) => `  ${row}`).join("\n")
      : "  (none)",
    "",
    "Viewport overlays",
    report.viewportOverlays.length > 0
      ? report.viewportOverlays.map((row) => `  ${row}`).join("\n")
      : "  (none)",
    "",
    "Gesture providers",
    JSON.stringify(report.gestureProviders, null, 2),
  ];
  return lines.join("\n");
}

export function releaseAllTrackedPointerCaptures(): number {
  let released = 0;
  for (const row of [...trackedCaptures]) {
    const before = row.element.hasPointerCapture(row.pointerId);
    releasePointerCaptureSafe(row.element, row.pointerId);
    if (before) released += 1;
    removeTrackedCapture(row.element, row.pointerId);
  }
  return released;
}

/** Best-effort recovery when the UI stops accepting pointer input. */
export function unlockUi(): { releasedCaptures: number } {
  const releasedCaptures = releaseAllTrackedPointerCaptures();
  abortEditorGestures();
  return { releasedCaptures };
}
