import { useState } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistantPane } from "./AssistantPane";
import type { AssistantChatTurn } from "../../project/assistantChat";

const serviceInvoke = vi.fn();
const cancelAssistantChat = vi.fn(async () => {});

vi.mock("../../services/serviceClient", () => ({
  serviceInvoke: (...args: unknown[]) => serviceInvoke(...args),
}));

vi.mock("../../project/assistantLlm", () => ({
  cancelAssistantChat: () => cancelAssistantChat(),
}));

describe("AssistantPane", () => {
  beforeEach(() => {
    serviceInvoke.mockReset();
    cancelAssistantChat.mockReset();
    cancelAssistantChat.mockResolvedValue(undefined);
  });

  it("asks through service_invoke and keeps fake proposals out", async () => {
    serviceInvoke.mockResolvedValue({
      mode: "result",
      data: { content: "Try a closer crop and warmer light." },
    });
    const user = userEvent.setup();
    function Harness() {
      const [messages, setMessages] = useState<AssistantChatTurn[]>([]);
      return (
        <AssistantPane
          projectId="p1"
          projectTitle="Night market"
          messages={messages}
          onPersist={setMessages}
          onCollapse={() => {}}
        />
      );
    }
    render(<Harness />);

    expect(screen.queryByText("Tighten the opening")).not.toBeInTheDocument();
    expect(
      screen.getByText(/can look up Assets and the timeline/i),
    ).toBeInTheDocument();

    const field = screen.getByPlaceholderText(/Ask about this project/i);
    expect(screen.queryByRole("button", { name: "Ask" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await user.type(field, "rewrite: a red fox");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(serviceInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "local",
        operation: "assistant_chat",
        projectId: "p1",
      }),
    );
    const payload = serviceInvoke.mock.calls[0]?.[0]?.payload as {
      projectId?: string;
      projectTitle?: string;
      messages?: Array<{ content: string }>;
    };
    expect(payload.projectId).toBe("p1");
    expect(payload.projectTitle).toBe("Night market");
    expect(payload).not.toHaveProperty("assetIds");
    expect(payload).not.toHaveProperty("timeline");
    expect(payload).not.toHaveProperty("model");
    expect(
      await screen.findByText("Try a closer crop and warmer light."),
    ).toBeInTheDocument();
  });

  it("renders assistant markdown", () => {
    render(
      <AssistantPane
        projectId="p1"
        projectTitle="Night market"
        messages={[
          {
            role: "assistant",
            content: "Use a **wider** lens.\n\n- fox\n- lantern",
            at: "t1",
          },
        ]}
        onPersist={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(screen.getByText("wider").closest("strong")).toBeTruthy();
    expect(screen.getByText("fox").closest("li")).toBeTruthy();
    expect(screen.getByText("lantern").closest("li")).toBeTruthy();
  });

  it("sends on Enter and inserts a line on Shift+Enter", async () => {
    serviceInvoke.mockResolvedValue({
      mode: "result",
      data: { content: "ok" },
    });
    const user = userEvent.setup();
    function Harness() {
      const [messages, setMessages] = useState<AssistantChatTurn[]>([]);
      return (
        <AssistantPane
          projectId="p1"
          projectTitle="Night market"
          messages={messages}
          onPersist={setMessages}
          onCollapse={() => {}}
        />
      );
    }
    render(<Harness />);
    const field = screen.getByPlaceholderText(/Ask about this project/i);
    await user.type(field, "first{Shift>}{Enter}{/Shift}second");
    expect(field).toHaveValue("first\nsecond");
    expect(serviceInvoke).not.toHaveBeenCalled();
    await user.type(field, "{Enter}");
    expect(serviceInvoke).toHaveBeenCalled();
  });

  it("turns Send into Stop and drops a cancelled reply", async () => {
    let finish: (value: unknown) => void = () => {};
    serviceInvoke.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    function Harness() {
      const [messages, setMessages] = useState<AssistantChatTurn[]>([]);
      return (
        <AssistantPane
          projectId="p1"
          projectTitle="Night market"
          messages={messages}
          onPersist={setMessages}
          onCollapse={() => {}}
        />
      );
    }
    render(<Harness />);
    const field = screen.getByPlaceholderText(/Ask about this project/i);
    await user.type(field, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toBeEnabled();
    await user.click(stop);
    expect(cancelAssistantChat).toHaveBeenCalled();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await act(async () => {
      finish({ mode: "result", data: { content: "late" } });
    });
    expect(screen.queryByText("late")).not.toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
