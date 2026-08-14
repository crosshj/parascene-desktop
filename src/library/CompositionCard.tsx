import { memo } from "react";
import type { StillWorkstream } from "../project/stillWorkstream";

export type CompositionCardProps = {
  composition: StillWorkstream;
  aspectCss: string;
  selected?: boolean;
  /** Count of source images referenced but not in the project folder. */
  outsideCount?: number;
  onOpen: (composition: StillWorkstream) => void;
  onContextMenu?: (
    composition: StillWorkstream,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
};

function CompositionCard({
  composition,
  aspectCss,
  selected = false,
  outsideCount = 0,
  onOpen,
  onContextMenu,
}: CompositionCardProps) {
  const outsideLabel =
    outsideCount > 0
      ? `${outsideCount} source${outsideCount === 1 ? "" : "s"} outside the project folder`
      : null;
  return (
    <div className="creation-card composition-card">
      <button
        type="button"
        className={`creation-card-hit composition-card-hit${
          selected ? " is-selected" : ""
        }${outsideCount > 0 ? " has-outside" : ""}`}
        onClick={() => onOpen(composition)}
        onContextMenu={
          onContextMenu
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenu(composition, event);
              }
            : undefined
        }
        aria-label={
          outsideLabel
            ? `Open composition: ${composition.title}. ${outsideLabel}`
            : `Open composition: ${composition.title}`
        }
        title={outsideLabel ? `${composition.title} — ${outsideLabel}` : composition.title}
      >
        <span
          className={`creation-card-clip composition-simple-card${
            outsideCount > 0 ? " has-outside" : ""
          }`}
          style={{ aspectRatio: aspectCss }}
        >
          {outsideCount > 0 ? (
            <span className="composition-outside-flag" aria-hidden>
              Outside
            </span>
          ) : null}
          Composition
        </span>
      </button>
    </div>
  );
}

export default memo(CompositionCard);
