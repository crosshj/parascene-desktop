import { ParasceneWordmark } from "./svgs";

export function Wordmark({
  className,
  width = 180,
}: {
  className?: string;
  width?: number;
}) {
  return (
    <div className={className ?? "wordmark"} aria-label="Parascene">
      <ParasceneWordmark width={width} />
    </div>
  );
}
