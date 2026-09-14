import type { ReactNode } from "react";
import {
  parseAssistantMarkdown,
  type MdBlock,
  type MdInline,
} from "./assistantMd";

function Inline({ nodes }: { nodes: MdInline[] }): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <span key={i}>{node.value}</span>;
      case "br":
        return <br key={i} />;
      case "code":
        return (
          <code key={i} className="editor-assistant-md-code">
            {node.value}
          </code>
        );
      case "strong":
        return (
          <strong key={i}>
            <Inline nodes={node.children} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <Inline nodes={node.children} />
          </em>
        );
      case "link":
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noreferrer noopener"
          >
            <Inline nodes={node.children} />
          </a>
        );
      default:
        return null;
    }
  });
}

function Lines({ lines }: { lines: MdInline[][] }): ReactNode {
  return lines.map((line, i) => (
    <span key={i}>
      {i > 0 ? <br /> : null}
      <Inline nodes={line} />
    </span>
  ));
}

function Block({ block }: { block: MdBlock }): ReactNode {
  switch (block.type) {
    case "p":
      return (
        <p>
          <Lines lines={block.lines} />
        </p>
      );
    case "h": {
      const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
      return (
        <Tag>
          <Inline nodes={block.children} />
        </Tag>
      );
    }
    case "ul":
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline nodes={item} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline nodes={item} />
            </li>
          ))}
        </ol>
      );
    case "pre":
      return (
        <pre>
          <code>{block.value}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote>
          <Lines lines={block.lines} />
        </blockquote>
      );
    default:
      return null;
  }
}

export function AssistantMarkdown({ text }: { text: string }) {
  const blocks = parseAssistantMarkdown(text);
  if (blocks.length === 0) return null;
  return (
    <div className="editor-assistant-md">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
