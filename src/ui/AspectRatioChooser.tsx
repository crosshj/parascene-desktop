import type { CSSProperties } from "react";
import type { ProjectAspectOption } from "../project/aspectRatios";

type Props = {
  value: string;
  options: readonly ProjectAspectOption[];
  disabled?: boolean;
  onChange: (next: string) => void;
  /** Optional section title above the row. */
  label?: string;
};

/** Fit glyph inside a square wrap while preserving ratio. */
function glyphBoxStyle(w: number, h: number): CSSProperties {
  if (w >= h) {
    return { width: "100%", aspectRatio: `${w} / ${h}` };
  }
  return { height: "100%", aspectRatio: `${w} / ${h}` };
}

/** Compact horizontal aspect picker: ratio · glyph · sublabel. */
export function AspectRatioChooser({
  value,
  options,
  disabled = false,
  onChange,
  label,
}: Props) {
  if (options.length === 0) return null;

  return (
    <div
      className="aspect-chooser"
      role="group"
      aria-label={label ?? "Aspect ratio"}
    >
      {label ? <span className="aspect-chooser-label">{label}</span> : null}
      <div className="aspect-chooser-options">
        {options.map((opt) => {
          const active = value === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              className={
                active
                  ? "aspect-chooser-option is-active"
                  : "aspect-chooser-option"
              }
              aria-pressed={active}
              disabled={disabled}
              title={`${opt.label} · ${opt.sublabel}`}
              onClick={() => onChange(opt.id)}
            >
              <span className="aspect-chooser-ratio">{opt.label}</span>
              <span className="aspect-chooser-glyph-wrap" aria-hidden>
                <span
                  className="aspect-chooser-glyph"
                  style={glyphBoxStyle(opt.w, opt.h)}
                />
              </span>
              <span className="aspect-chooser-sub">{opt.sublabel}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
