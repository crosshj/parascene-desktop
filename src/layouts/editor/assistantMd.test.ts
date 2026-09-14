import { describe, expect, it } from "vitest";
import {
  normalizeChatMarkdown,
  parseAssistantMarkdown,
  parseInline,
  safeHref,
} from "./assistantMd";

describe("assistantMd", () => {
  it("keeps http links and drops javascript", () => {
    expect(safeHref("https://parascene.com/x")).toBe("https://parascene.com/x");
    expect(safeHref("javascript:alert(1)")).toBeNull();
  });

  it("parses bold, italic, and inline code", () => {
    expect(parseInline("Try a **wider** lens and `seed`")).toEqual([
      { type: "text", value: "Try a " },
      { type: "strong", children: [{ type: "text", value: "wider" }] },
      { type: "text", value: " lens and " },
      { type: "code", value: "seed" },
    ]);
    expect(parseInline("say *hello*")).toEqual([
      { type: "text", value: "say " },
      { type: "em", children: [{ type: "text", value: "hello" }] },
    ]);
  });

  it("splits paragraphs, lists, headings, and fences", () => {
    const blocks = parseAssistantMarkdown(
      [
        "# Night market",
        "",
        "A **fox**.",
        "Second line.",
        "",
        "- still",
        "- clip",
        "",
        "```",
        "prompt here",
        "```",
      ].join("\n"),
    );
    expect(blocks[0]).toMatchObject({ type: "h", level: 1 });
    expect(blocks[1]).toMatchObject({ type: "p" });
    expect(blocks[1]).toEqual({
      type: "p",
      lines: [
        [
          { type: "text", value: "A " },
          { type: "strong", children: [{ type: "text", value: "fox" }] },
          { type: "text", value: "." },
        ],
        [{ type: "text", value: "Second line." }],
      ],
    });
    expect(blocks[2]).toEqual({
      type: "ul",
      items: [[{ type: "text", value: "still" }], [{ type: "text", value: "clip" }]],
    });
    expect(blocks[3]).toEqual({ type: "pre", value: "prompt here" });
  });

  it("breaks one-line headings and numbered items onto their own lines", () => {
    const normalized = normalizeChatMarkdown(
      'project "Untitled": ### Assets: 1. **Image**: fox.png 2. **Audio**: song.mp3',
    );
    expect(normalized).toBe(
      [
        'project "Untitled":',
        "",
        "### Assets:",
        "1. **Image**: fox.png",
        "2. **Audio**: song.mp3",
      ].join("\n"),
    );
    const blocks = parseAssistantMarkdown(normalized);
    expect(blocks.map((block) => block.type)).toEqual(["p", "h", "ol"]);
    const heading = blocks[1];
    expect(heading).toMatchObject({ type: "h", level: 3 });
  });

  it("does not treat a javascript url as a link", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([
      { type: "text", value: "[x](javascript:alert(1))" },
    ]);
  });
});
