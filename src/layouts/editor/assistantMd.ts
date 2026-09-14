/** Safe chat markdown. No HTML. http(s) links only. */

export type MdInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: MdInline[] }
  | { type: "br" };

export type MdBlock =
  | { type: "p"; lines: MdInline[][] }
  | { type: "h"; level: 1 | 2 | 3; children: MdInline[] }
  | { type: "ul"; items: MdInline[][] }
  | { type: "ol"; items: MdInline[][] }
  | { type: "pre"; value: string }
  | { type: "quote"; lines: MdInline[][] };

const SAFE_HREF = /^(https?:)\/\//i;

export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!SAFE_HREF.test(trimmed)) return null;
  return trimmed;
}

function nextMarkup(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "`" || ch === "*" || ch === "_" || ch === "[") return i;
  }
  return text.length;
}

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let i = 0;
  const pushText = (value: string) => {
    if (value) out.push({ type: "text", value });
  };
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        out.push({ type: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith("**", i) || text.startsWith("__", i)) {
      const mark = text.slice(i, i + 2);
      const end = text.indexOf(mark, i + 2);
      if (end > i + 1) {
        out.push({
          type: "strong",
          children: parseInline(text.slice(i + 2, end)),
        });
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*" || text[i] === "_") {
      const mark = text[i] ?? "";
      const end = text.indexOf(mark, i + 1);
      if (end > i + 1) {
        out.push({
          type: "em",
          children: parseInline(text.slice(i + 1, end)),
        });
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const endParen = text.indexOf(")", close + 2);
        if (endParen > close) {
          const label = parseInline(text.slice(i + 1, close));
          const href = safeHref(text.slice(close + 2, endParen));
          if (href) {
            out.push({ type: "link", href, children: label });
            i = endParen + 1;
            continue;
          }
        }
      }
    }
    const next = nextMarkup(text, i + 1);
    pushText(text.slice(i, next));
    i = next;
  }
  return out;
}

function headingLevel(line: string): 1 | 2 | 3 | 0 {
  const match = /^(#{1,3})\s+(.+)$/.exec(line);
  if (!match) return 0;
  const n = match[1].length;
  return n === 1 || n === 2 || n === 3 ? n : 0;
}

function headingText(line: string): string {
  return line.replace(/^#{1,3}\s+/, "").replace(/\s+#+\s*$/, "");
}

function listKind(line: string): "ul" | "ol" | null {
  if (/^\s*[-*+]\s+/.test(line)) return "ul";
  if (/^\s*\d+[.)]\s+/.test(line)) return "ol";
  return null;
}

function listItemText(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
}

function quoteText(line: string): string {
  return line.replace(/^\s*>\s?/, "");
}

/** Models often dump ### / 1. markup in one line. Put those on their own lines. */
export function normalizeChatMarkdown(source: string): string {
  return source
    .replace(/\r\n/g, "\n")
    .replace(/([^\n])[ \t]+(#{1,3}[ \t]+)/g, "$1\n\n$2")
    .replace(/([^\n])[ \t]+(\d+[.)][ \t]+)/g, "$1\n$2")
    .replace(/([^\n])[ \t]+([-*+][ \t]+)/g, "$1\n$2");
}

export function parseAssistantMarkdown(source: string): MdBlock[] {
  const lines = normalizeChatMarkdown(source).split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    const kept = buf.map((line) => line.trimEnd());
    while (kept.length && kept[0] === "") kept.shift();
    while (kept.length && kept[kept.length - 1] === "") kept.pop();
    if (!kept.length) return;
    blocks.push({ type: "p", lines: kept.map((line) => parseInline(line)) });
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "pre", value: body.join("\n") });
      continue;
    }

    if (!trimmed) {
      i += 1;
      continue;
    }

    const heading = headingLevel(trimmed);
    if (heading) {
      blocks.push({
        type: "h",
        level: heading,
        children: parseInline(headingText(trimmed)),
      });
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoted.push(quoteText(lines[i] ?? ""));
        i += 1;
      }
      blocks.push({ type: "quote", lines: quoted.map((row) => parseInline(row)) });
      continue;
    }

    const kind = listKind(line);
    if (kind) {
      const items: MdInline[][] = [];
      while (i < lines.length && listKind(lines[i] ?? "") === kind) {
        items.push(parseInline(listItemText(lines[i] ?? "")));
        i += 1;
      }
      blocks.push({ type: kind, items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (!next.trim()) break;
      if (next.trim().startsWith("```")) break;
      if (headingLevel(next.trim())) break;
      if (listKind(next)) break;
      if (next.trim().startsWith(">")) break;
      para.push(next);
      i += 1;
    }
    flushParagraph(para);
  }

  return blocks;
}
