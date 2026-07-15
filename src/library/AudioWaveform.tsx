/** Stylized purple waveform for audio cards / lightbox / asset tiles. */
export function AudioWaveform({
  className = "creation-audio-wave",
}: {
  className?: string;
}) {
  // Symmetric bars in a square viewBox. Solid fill (currentColor) — no gradient
  // url(#…) which can fail to paint in WebView.
  const bars = [10, 18, 28, 40, 52, 40, 28, 18, 10, 16, 26, 38, 50, 38, 26, 16, 10];
  const midY = 50;
  const gap = 5;
  const barW = 3.5;
  const span = bars.length * gap - (gap - barW);
  const startX = (100 - span) / 2;

  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      width="100"
      height="100"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      {bars.map((h, i) => {
        const height = (h / 52) * 44;
        const x = startX + i * gap;
        const y = midY - height / 2;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={height}
            rx={1.25}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
}
