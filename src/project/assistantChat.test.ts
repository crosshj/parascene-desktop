import { describe, expect, it } from "vitest";
import {
  assistantChatEqual,
  assistantChatInvokePayload,
  assistantSystemPrompt,
  normalizeAssistantChat,
  replyFromAssistantResult,
} from "./assistantChat";

describe("assistantChat", () => {
  it("names the project and allows read tools", () => {
    const prompt = assistantSystemPrompt("  Goblin cut  ");
    expect(prompt).toContain('titled "Goblin cut"');
    expect(prompt).toContain("read tools");
    expect(prompt).toContain("cannot generate");
    expect(prompt).not.toContain("cannot see Assets");
    expect(prompt).not.toContain("creationIds");
    expect(prompt).not.toContain("assetIds");
  });

  it("drops empty and unknown turns, keeps the tail", () => {
    expect(normalizeAssistantChat(null)).toEqual([]);
    expect(
      normalizeAssistantChat([
        { role: "user", content: "  hello  ", at: "t1" },
        { role: "system", content: "nope", at: "t2" },
        { role: "assistant", content: "", at: "t3" },
        { role: "assistant", content: "hi", at: "t4" },
      ]),
    ).toEqual([
      { role: "user", content: "hello", at: "t1" },
      { role: "assistant", content: "hi", at: "t4" },
    ]);
  });

  it("builds an invoke payload without dumping assets or a model name", () => {
    const payload = assistantChatInvokePayload({
      projectId: "p1",
      projectTitle: "Night market",
      messages: [{ role: "user", content: "earlier", at: "t0" }],
      userMessage: "  tighten this prompt: a red fox  ",
    });
    expect(payload.projectId).toBe("p1");
    expect(payload.projectTitle).toBe("Night market");
    expect(payload.system).toContain('titled "Night market"');
    expect(payload.system).toContain("read tools");
    expect(payload.messages).toEqual([
      { role: "user", content: "earlier" },
      { role: "user", content: "tighten this prompt: a red fox" },
    ]);
    expect(payload).not.toHaveProperty("assetIds");
    expect(payload).not.toHaveProperty("timeline");
    expect(payload).not.toHaveProperty("model");
    expect(JSON.stringify(payload)).not.toContain("creationIds");
    expect(JSON.stringify(payload)).not.toContain("openai");
    expect(JSON.stringify(payload)).not.toContain("gpt-");
  });

  it("reads the model reply from a service result", () => {
    expect(replyFromAssistantResult({ content: "  try a wider lens  " })).toBe(
      "try a wider lens",
    );
    expect(replyFromAssistantResult({ reply: "ok" })).toBe("ok");
    expect(replyFromAssistantResult({})).toBe("");
  });

  it("compares persisted turns", () => {
    const turn = { role: "user" as const, content: "hi", at: "t1" };
    expect(assistantChatEqual([turn], [{ ...turn }])).toBe(true);
    expect(assistantChatEqual([turn], [{ ...turn, content: "hey" }])).toBe(
      false,
    );
  });
});
