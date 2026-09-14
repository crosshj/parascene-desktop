import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyOpenAiKeyChanged } from "../settings/events";

const serviceDescribe = vi.fn();
const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("../services/serviceClient", () => ({
  serviceDescribe: (...args: unknown[]) => serviceDescribe(...args),
}));

import {
  assistantLlmConfigured,
  cancelAssistantChat,
  editorAssistantVisible,
  useAssistantLlmConfigured,
} from "./assistantLlm";

describe("assistantLlmConfigured", () => {
  beforeEach(() => {
    serviceDescribe.mockReset();
    invoke.mockReset();
  });

  it("is true when the assistant service has credentials", async () => {
    serviceDescribe.mockResolvedValue({
      service: "local",
      operation: "assistant_chat",
      status: "wired",
      fields: [],
      credentials: { required: true, configured: true },
    });
    await expect(assistantLlmConfigured()).resolves.toBe(true);
    expect(serviceDescribe).toHaveBeenCalledWith({
      service: "local",
      operation: "assistant_chat",
    });
  });

  it("is false when no adapter is configured", async () => {
    serviceDescribe.mockResolvedValue({
      service: "local",
      operation: "assistant_chat",
      status: "wired",
      fields: [],
      credentials: { required: true, configured: false },
    });
    await expect(assistantLlmConfigured()).resolves.toBe(false);
  });
});

describe("editorAssistantVisible", () => {
  it("is only for v2 projects with a configured adapter", () => {
    expect(editorAssistantVisible(true, true)).toBe(true);
    expect(editorAssistantVisible(true, false)).toBe(false);
    expect(editorAssistantVisible(false, true)).toBe(false);
    expect(editorAssistantVisible(false, false)).toBe(false);
  });
});

describe("useAssistantLlmConfigured", () => {
  beforeEach(() => {
    serviceDescribe.mockReset();
  });

  it("stays false until describe reports credentials", async () => {
    serviceDescribe.mockResolvedValue({
      service: "local",
      operation: "assistant_chat",
      status: "wired",
      fields: [],
      credentials: { required: true, configured: true },
    });
    const { result } = renderHook(() => useAssistantLlmConfigured());
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("turns off after credentials are cleared", async () => {
    serviceDescribe.mockResolvedValue({
      service: "local",
      operation: "assistant_chat",
      status: "wired",
      fields: [],
      credentials: { required: true, configured: true },
    });
    const { result } = renderHook(() => useAssistantLlmConfigured());
    await waitFor(() => expect(result.current).toBe(true));
    serviceDescribe.mockResolvedValue({
      service: "local",
      operation: "assistant_chat",
      status: "wired",
      fields: [],
      credentials: { required: true, configured: false },
    });
    act(() => {
      notifyOpenAiKeyChanged();
    });
    await waitFor(() => expect(result.current).toBe(false));
  });
});

describe("cancelAssistantChat", () => {
  it("invokes assistant_chat_cancel", async () => {
    invoke.mockResolvedValue(undefined);
    await cancelAssistantChat();
    expect(invoke).toHaveBeenCalledWith("assistant_chat_cancel");
  });
});
