/** Persistent non-blocking WIP watermark. */
export function WipOverlay() {
  return (
    <div className="wip-overlay" aria-hidden="true">
      <div className="wip-watermark">Work In Progress</div>
    </div>
  );
}
