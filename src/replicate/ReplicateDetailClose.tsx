type Props = {
  onClick: () => void;
  /** Pin to the top-right of a cover/hero image. */
  overlay?: boolean;
};

export function ReplicateDetailClose({ onClick, overlay = false }: Props) {
  return (
    <button
      type="button"
      className={[
        "lab-replicate-detail-close",
        overlay ? "is-overlay" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Close detail"
      onClick={onClick}
    >
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
        <path
          fill="currentColor"
          d="M2.1 1.4 6 5.3l3.9-3.9.7.7L6.7 6l3.9 3.9-.7.7L6 6.7l-3.9 3.9-.7-.7L5.3 6 1.4 2.1z"
        />
      </svg>
    </button>
  );
}
