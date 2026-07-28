/** Preview local Replicate run outputs (image / audio / video). */

import { convertFileSrc } from "@tauri-apps/api/core";
import {
  outputMediaKind,
  type OutputMediaKind,
} from "./outputMediaKind";

function fileSrc(path: string, kind: OutputMediaKind): string {
  // A/V must use Range-capable `media` — `asset://` buffers whole files first.
  if (kind === "audio" || kind === "video") {
    return convertFileSrc(path, "media");
  }
  return convertFileSrc(path);
}

type Props = {
  path: string;
  /** Show filesystem path under the player (detail pane). */
  showPath?: boolean;
  /** Smaller player for list rows. */
  compact?: boolean;
};

export function ReplicateLocalOutput({
  path,
  showPath = true,
  compact = false,
}: Props) {
  const kind = outputMediaKind(path);
  const src = fileSrc(path, kind);
  const className = compact
    ? "lab-replicate-run-output is-compact"
    : "lab-replicate-run-output";

  return (
    <div className={className}>
      {kind === "image" ? (
        <img src={src} alt="Prediction output" />
      ) : kind === "audio" ? (
        <audio
          controls
          src={src}
          className="lab-audio lab-replicate-output-audio"
          preload="metadata"
        />
      ) : kind === "video" ? (
        <video
          controls
          src={src}
          className="lab-video lab-replicate-output-video"
          playsInline
          preload="metadata"
        />
      ) : null}
      {showPath ? <code className="lab-replicate-output-path">{path}</code> : null}
    </div>
  );
}
