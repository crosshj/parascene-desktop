import { openUrl } from "@tauri-apps/plugin-opener";
import { cloudHostCaption, cloudPlayAction } from "./cloudImport";
import type { Creation } from "./types";

export function CloudHostNote({
  creation,
  className,
}: {
  creation: Creation;
  className?: string;
}) {
  const caption = cloudHostCaption(creation);
  const play = cloudPlayAction(creation);
  if (!caption) return null;
  return (
    <div className={className ?? "cloud-host-note"}>
      <p className="muted cloud-host-caption">{caption}</p>
      {play ? (
        <button
          type="button"
          className="btn ghost cloud-host-play"
          onClick={() => {
            void openUrl(play.url);
          }}
        >
          {play.label}
        </button>
      ) : null}
    </div>
  );
}
