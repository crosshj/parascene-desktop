/**
 * Shared scalar/enum/slider/aspect schema field (non-file).
 * File/media slots stay in Lab panels until the shared media slot lands.
 */
import type { ReplicateInputField } from "../replicate/replicateClient";
import {
  isProjectAspectRatio,
  pickAspectChooserValue,
  projectAspectCss,
} from "../project/aspectRatios";
import { AspectRatioChooser } from "../ui/AspectRatioChooser";
import {
  aspectChooserOptionsForField,
  clampNumericString,
  formatDefaultLabel,
  hasSliderRange,
  isPromptLikeField,
  resolveFormValue,
  sliderStep,
} from "./schemaForm";

export type SchemaScalarFieldProps = {
  field: ReplicateInputField;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  disabled?: boolean;
  /** Show a small aspect-ratio preview box (Blue Lab). */
  showAspectPreview?: boolean;
};

export function SchemaScalarField({
  field,
  values,
  onChange,
  disabled = false,
  showAspectPreview = false,
}: SchemaScalarFieldProps) {
  const label = field.title || field.name;
  const value = resolveFormValue(field, values);
  const enums = field.enumValues ?? null;
  const setValue = (next: string) => onChange(field.name, next);
  const showSlider = hasSliderRange(field);
  const defaultLabel = formatDefaultLabel(field);
  const aspectOpts = aspectChooserOptionsForField(field);
  const rangeLabel =
    field.minimum != null && field.maximum != null
      ? `(minimum: ${field.minimum}, maximum: ${field.maximum})`
      : null;
  const isPromptLike = isPromptLikeField(field);

  if (aspectOpts.length > 0) {
    const aspectValue = pickAspectChooserValue(aspectOpts, value);
    const aspectCss =
      showAspectPreview && isProjectAspectRatio(aspectValue)
        ? projectAspectCss(aspectValue)
        : null;
    return (
      <div key={field.name} className="lab-replicate-run-field">
        <div className="lab-replicate-run-field-head">
          <span>
            <span className="lab-replicate-run-field-name">{field.name}</span>
            <span className="muted">
              {" "}
              {field.typeName}
              {field.required ? " · required" : ""}
            </span>
          </span>
        </div>
        {label !== field.name ? (
          <div className="muted lab-replicate-run-field-title">{label}</div>
        ) : null}
        <AspectRatioChooser
          value={aspectValue}
          options={aspectOpts}
          disabled={disabled}
          onChange={setValue}
        />
        {aspectCss ? (
          <span
            className="lab-replicate-aspect-preview"
            style={{ aspectRatio: aspectCss }}
          />
        ) : null}
        {field.description ? (
          <p className="muted lab-replicate-run-help">{field.description}</p>
        ) : null}
        {defaultLabel != null ? (
          <p className="muted lab-replicate-run-default">
            Default: {defaultLabel}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div key={field.name} className="lab-replicate-run-field">
      {field.typeName === "boolean" ? (
        <label className="lab-replicate-run-check">
          <input
            type="checkbox"
            checked={value === "true"}
            disabled={disabled}
            onChange={(e) => setValue(e.target.checked ? "true" : "false")}
          />
          <span>
            <span className="lab-replicate-run-field-name">{field.name}</span>
            <span className="muted">
              {" "}
              {field.typeName}
              {field.required ? " · required" : ""}
            </span>
          </span>
        </label>
      ) : (
        <>
          <div className="lab-replicate-run-field-head">
            <span>
              <span className="lab-replicate-run-field-name">{field.name}</span>
              <span className="muted">
                {" "}
                {field.typeName}
                {field.required ? " · required" : ""}
              </span>
            </span>
            {rangeLabel ? (
              <span className="muted lab-replicate-run-range-label">
                {rangeLabel}
              </span>
            ) : null}
          </div>
          {label !== field.name ? (
            <div className="muted lab-replicate-run-field-title">{label}</div>
          ) : null}

          {enums && enums.length > 0 ? (
            <select
              className="control"
              value={value}
              disabled={disabled}
              onChange={(e) => setValue(e.target.value)}
            >
              {!field.required && !value ? (
                <option value="">(default)</option>
              ) : null}
              {enums.map((opt) => (
                <option key={opt} value={opt}>
                  {field.enumLabels?.[opt] ?? opt}
                </option>
              ))}
            </select>
          ) : isPromptLike ? (
            <textarea
              className="control"
              rows={3}
              value={value}
              disabled={disabled}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : field.typeName === "integer" || field.typeName === "number" ? (
            showSlider ? (
              <div className="lab-replicate-run-slider-row">
                <input
                  className="control lab-replicate-run-number"
                  type="number"
                  min={field.minimum ?? undefined}
                  max={field.maximum ?? undefined}
                  step={sliderStep(field)}
                  value={value}
                  disabled={disabled}
                  onChange={(e) =>
                    setValue(clampNumericString(e.target.value, field))
                  }
                />
                <input
                  className="lab-replicate-run-range"
                  type="range"
                  min={field.minimum!}
                  max={field.maximum!}
                  step={sliderStep(field)}
                  value={
                    Number.isFinite(Number(value))
                      ? Number(value)
                      : (field.minimum ?? 0)
                  }
                  disabled={disabled}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
            ) : (
              <input
                className="control"
                type="number"
                min={field.minimum ?? undefined}
                max={field.maximum ?? undefined}
                step={field.typeName === "integer" ? 1 : "any"}
                value={value}
                disabled={disabled}
                onChange={(e) => setValue(e.target.value)}
              />
            )
          ) : (
            <input
              className="control"
              type="text"
              value={value}
              disabled={disabled}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </>
      )}

      {field.description ? (
        <p className="muted lab-replicate-run-help">{field.description}</p>
      ) : null}
      {defaultLabel != null ? (
        <p className="muted lab-replicate-run-default">Default: {defaultLabel}</p>
      ) : null}
    </div>
  );
}
