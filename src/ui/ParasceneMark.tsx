/** Header / Generate Parascene mark — keep in sync with `src/assets/parascene-mark.svg`. */
export function ParasceneMark({
  className,
  tone = "default",
}: {
  className?: string;
  /** `blue` = Direct to Blue (cyan plate). */
  tone?: "default" | "blue";
}) {
  const plate = tone === "blue" ? "var(--select)" : "var(--muted)";
  const glyph = tone === "blue" ? "var(--bg)" : "var(--surface)";
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      <rect width="64" height="64" rx="14" style={{ fill: plate }} />
      <path
        className="parascene-mark-glyph"
        style={{ fill: glyph }}
        d="M 22.859 16.293 L 31.248 16.293 L 30.538 19.664 C 32.328 18.182 34.003 17.119 35.565 16.478 C 37.129 15.839 38.805 15.519 40.593 15.519 C 44.027 15.519 46.787 16.706 48.874 19.076 C 50.962 21.448 52.006 24.984 52.006 29.685 C 52.006 35.604 50.207 40.605 46.608 44.688 C 43.525 48.173 39.874 49.915 35.659 49.915 C 31.319 49.915 28.039 48.152 25.819 44.625 L 22.272 61.668 L 13.419 61.668 L 22.859 16.293 Z M 28.194 35.129 C 28.194 37.687 28.816 39.67 30.059 41.084 C 31.304 42.498 32.768 43.203 34.454 43.203 C 35.915 43.203 37.324 42.671 38.681 41.609 C 40.039 40.548 41.164 38.785 42.058 36.321 C 42.954 33.857 43.401 31.572 43.401 29.47 C 43.401 27.016 42.815 25.134 41.642 23.824 C 40.47 22.516 38.98 21.86 37.17 21.86 C 35.484 21.86 33.946 22.464 32.558 23.671 C 31.171 24.876 30.096 26.65 29.335 28.99 C 28.575 31.331 28.194 33.377 28.194 35.129 Z"
      />
    </svg>
  );
}
