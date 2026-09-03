/**
 * Prompt textarea that hugs its text, never shorter than 3 lines.
 * A hidden replica in the same grid cell sizes the box (scrollHeight is
 * unreliable against CSS min-height in WKWebView).
 */
import type { TextareaHTMLAttributes } from "react";

export type AutosizeTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function AutosizeTextarea({
  className,
  value,
  rows = 3,
  ...props
}: AutosizeTextareaProps) {
  const text = value == null ? "" : String(value);
  return (
    <div
      className={["control", "autosize-textarea", className]
        .filter(Boolean)
        .join(" ")}
      data-autosize={text}
    >
      <textarea
        {...props}
        rows={rows}
        value={value}
        className="is-auto-size"
      />
    </div>
  );
}
