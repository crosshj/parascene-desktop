import { describe, expect, it } from "vitest";
import {
  collectUiDiagnostics,
  formatUiDiagnosticsReport,
  installPointerCaptureSpy,
  registerGestureStatusProvider,
  type UiDiagnosticsReport,
} from "./uiDiagnostics";

describe("uiDiagnostics", () => {
  it("includes registered gesture provider snapshots", () => {
    const unregister = registerGestureStatusProvider("test", () => ({
      dragging: true,
      kind: "timeline",
    }));
    const report = collectUiDiagnostics();
    expect(report.gestureProviders.test).toEqual({
      dragging: true,
      kind: "timeline",
    });
    unregister();
  });

  it("formats a readable report", () => {
    const report: UiDiagnosticsReport = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      window: {
        hasFocus: true,
        visibility: "visible",
        width: 1200,
        height: 800,
      },
      focus: { activeElement: "button.auth-account" },
      bodyClasses: [],
      editorWorkspaceClasses: [],
      activePointerCaptures: [],
      gestureProviders: {},
      stagedClipDrag: { active: false, kind: null },
      openModals: [],
      centerHitTarget: "main.app-main",
      centerHitStack: ["main.app-main"],
      viewportOverlays: [],
      notes: ["No obvious stuck pointer capture or drag state."],
    };
    const text = formatUiDiagnosticsReport(report);
    expect(text).toContain("Parascene UI diagnostics");
    expect(text).toContain("main.app-main");
  });

  it("tracks pointer capture after spy install", () => {
    installPointerCaptureSpy();
    const el = document.createElement("button");
    document.body.appendChild(el);
    if (typeof el.setPointerCapture !== "function") {
      el.remove();
      return;
    }
    try {
      el.setPointerCapture(3);
    } catch {
      // jsdom may not fully implement pointer capture.
    }
    const report = collectUiDiagnostics();
    expect(report.activePointerCaptures.some((row) => row.pointerId === 3)).toBe(
      true,
    );
    el.remove();
  });
});
