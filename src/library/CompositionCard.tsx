import { memo } from "react";
import type { StillWorkstream } from "../project/stillWorkstream";

export type CompositionCardProps = {
  composition: StillWorkstream;
  aspectCss: string;
  selected?: boolean;
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
  onOpen,
  onContextMenu,
}: CompositionCardProps) {
  return (
    <div className="creation-card composition-card">
      <button
        type="button"
        className={`creation-card-hit composition-card-hit${
          selected ? " is-selected" : ""
        }`}
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
        aria-label={`Open composition: ${composition.title}`}
        title={composition.title}
      >
        <span
          className="creation-card-clip composition-simple-card"
          style={{ aspectRatio: aspectCss }}
        >
          Composition
        </span>
      </button>
    </div>
  );
}

export default memo(CompositionCard);
