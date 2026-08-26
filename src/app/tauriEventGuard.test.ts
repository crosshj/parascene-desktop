import { afterEach, describe, expect, it, vi } from "vitest";
import { guardTauriUnregisterListener } from "./tauriEventGuard";

type TestWindow = Window &
  typeof globalThis & {
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: (event: string, eventId: number) => void;
    };
  };

const testWindow = window as TestWindow;

afterEach(() => {
  Reflect.deleteProperty(testWindow, "__TAURI_EVENT_PLUGIN_INTERNALS__");
});

describe("guardTauriUnregisterListener", () => {
  it("swallows stale-id TypeErrors and still calls through for live ids", () => {
    const original = vi.fn((_event: string, eventId: number) => {
      if (eventId === 404) {
        throw new TypeError(
          "undefined is not an object (evaluating 'listeners[eventId].handlerId')",
        );
      }
    });
    testWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: original,
    };
    guardTauriUnregisterListener();
    const internals = testWindow.__TAURI_EVENT_PLUGIN_INTERNALS__;
    expect(() => internals.unregisterListener("evt", 404)).not.toThrow();
    internals.unregisterListener("evt", 1);
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when the Tauri internals are absent", () => {
    expect(() => guardTauriUnregisterListener()).not.toThrow();
  });
});
